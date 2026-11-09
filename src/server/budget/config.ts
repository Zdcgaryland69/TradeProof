// Budget configuration for LIVE model calls, read from the environment per call (names are reported,
// values never are). Anything missing, unapproved, unparseable or not matching the configured model
// refuses real calls. No price is built in: prices are filled in only after the owner chooses the
// provider, model and billing currency.

import type { BudgetLimits } from "../../lib/budget.ts";

export const BUDGET_ENV = {
  approved: "AI_BUDGET_APPROVED",
  currency: "AI_BUDGET_CURRENCY",
  totalLimit: "AI_BUDGET_TOTAL_LIMIT",
  dailyLimit: "AI_BUDGET_DAILY_LIMIT",
  totalCalls: "AI_BUDGET_TOTAL_MAX_CALLS",
  dailyCalls: "AI_BUDGET_DAILY_MAX_CALLS",
  priceProvider: "AI_PRICE_PROVIDER",
  priceModel: "AI_PRICE_MODEL",
  inputPerMTok: "AI_PRICE_INPUT_PER_MTOK",
  outputPerMTok: "AI_PRICE_OUTPUT_PER_MTOK",
  perRequest: "AI_PRICE_PER_REQUEST",
} as const;

/** Prices in the budget currency, micro-units. Per million tokens for input and output. */
export interface Prices {
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  perRequestMicros: number;
}

export interface BudgetConfig {
  currency: string;
  limits: BudgetLimits;
  provider: string;
  model: string;
  prices: Prices;
}

export type BudgetConfigResult = { ok: true; config: BudgetConfig } | { ok: false; missing: string[]; problems: string[] };

/** "12.50" → 12_500_000 micro-units. Up to 6 decimals; no signs, exponents or separators. */
export function parseMicros(text: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  const v = BigInt(m[1]) * BigInt(1_000_000) + BigInt((m[2] ?? "").padEnd(6, "0"));
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

function parseCount(text: string): number | null {
  return /^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : null;
}

/**
 * The budget for real calls of `provider` / `model`. Refused unless every value is present and valid,
 * AI_BUDGET_APPROVED is exactly "yes", and the prices are stated for this exact provider and model
 * (so switching AI_MODEL without new prices refuses instead of reusing old prices).
 */
export function resolveBudgetConfig(provider: string, model: string, env: Record<string, string | undefined> = process.env): BudgetConfigResult {
  const get = (name: string) => (env[name] ?? "").trim();
  const missing = Object.values(BUDGET_ENV).filter((name) => get(name) === "");
  if (missing.length > 0) return { ok: false, missing, problems: ["The API budget is not configured, so no real model call is made."] };

  const problems: string[] = [];
  if (get(BUDGET_ENV.approved) !== "yes") problems.push(`${BUDGET_ENV.approved} must be "yes" (the owner's approval of this budget).`);
  const currency = get(BUDGET_ENV.currency);
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`${BUDGET_ENV.currency} must be a 3-letter currency code in capitals (the provider's billing currency).`);
  const micros = (name: string, positive: boolean) => {
    const v = parseMicros(get(name));
    if (v === null || (positive && v === 0)) problems.push(`${name} must be a ${positive ? "positive " : ""}decimal amount with at most 6 decimals.`);
    return v ?? 0;
  };
  const count = (name: string) => {
    const v = parseCount(get(name));
    if (v === null || v === 0) problems.push(`${name} must be a positive whole number.`);
    return v ?? 0;
  };
  const limits: BudgetLimits = {
    totalMicros: micros(BUDGET_ENV.totalLimit, true),
    dailyMicros: micros(BUDGET_ENV.dailyLimit, true),
    totalCalls: count(BUDGET_ENV.totalCalls),
    dailyCalls: count(BUDGET_ENV.dailyCalls),
  };
  if (limits.dailyMicros > limits.totalMicros) problems.push(`${BUDGET_ENV.dailyLimit} cannot exceed ${BUDGET_ENV.totalLimit}.`);
  if (limits.dailyCalls > limits.totalCalls) problems.push(`${BUDGET_ENV.dailyCalls} cannot exceed ${BUDGET_ENV.totalCalls}.`);
  // A zero token price would make every call look free: refused as "price unknown".
  const prices: Prices = {
    inputPerMTokMicros: micros(BUDGET_ENV.inputPerMTok, true),
    outputPerMTokMicros: micros(BUDGET_ENV.outputPerMTok, true),
    perRequestMicros: micros(BUDGET_ENV.perRequest, false),
  };
  if (get(BUDGET_ENV.priceProvider).toLowerCase() !== provider.toLowerCase() || get(BUDGET_ENV.priceModel) !== model) {
    problems.push(`The prices are stated for another provider or model (${BUDGET_ENV.priceProvider} / ${BUDGET_ENV.priceModel} must equal the configured provider and model).`);
  }
  if (problems.length > 0) return { ok: false, missing: [], problems };
  return { ok: true, config: { currency, limits, provider, model, prices } };
}

// ---------- cost bounds and estimates (integer arithmetic, rounded up) ----------

/**
 * Margin on the provider's token count. Anthropic documents its count as "an estimate" that "might differ
 * by a small amount" (token-counting docs, checked 25 Oct 2026), so the reservation adds 10 % + 256 tokens.
 * The 25 Oct UTF-8 byte bound is no longer used: it was never verified for the provider's tokenizer.
 */
export const TOKEN_COUNT_MARGIN = { percent: 10, extra: 256 } as const;

export function reservedInputTokens(countedTokens: number): number {
  return Math.ceil((countedTokens * (100 + TOKEN_COUNT_MARGIN.percent)) / 100) + TOKEN_COUNT_MARGIN.extra;
}

/**
 * Headroom on every reservation for price multipliers the request does not control: with no
 * inference_geo in the request, the workspace default applies, and US-only routing is billed at 1.1x
 * (pricing docs, checked 25 Oct 2026). Settlement uses the configured prices only when the response
 * reports global routing; otherwise the reservation stays UNKNOWN.
 */
export const RESERVATION_MULTIPLIER = { num: 11, den: 10 } as const;

const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;
const MTOK = BigInt(1_000_000);

/** Reserved upper bound for one attempt: cost at the configured prices × 1.1, rounded up. */
export function boundMicros(prices: Prices, inputTokens: number, outputTokens: number): number {
  return Number(ceilDiv(BigInt(costMicros(prices, inputTokens, outputTokens)) * BigInt(RESERVATION_MULTIPLIER.num), BigInt(RESERVATION_MULTIPLIER.den)));
}

/** micro-units for `inputTokens` / `outputTokens` at `prices`, each part rounded up; plus the per-request fee. */
export function costMicros(prices: Prices, inputTokens: number, outputTokens: number): number {
  const v =
    ceilDiv(BigInt(inputTokens) * BigInt(prices.inputPerMTokMicros), MTOK) +
    ceilDiv(BigInt(outputTokens) * BigInt(prices.outputPerMTokMicros), MTOK) +
    BigInt(prices.perRequestMicros);
  return Number(v);
}
