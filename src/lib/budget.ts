// Overall API budget for LIVE model calls made through this app: what the page may show.
// Pure TypeScript, shared by server and browser.
//
// Money is stored as integer micro-units (1/1,000,000) of ONE named currency, never as floating point.
// Every LIVE attempt reserves an upper bound before the call; after the call the reservation is either
// SETTLED (an estimate computed from the usage the provider reported, at the configured prices),
// RELEASED (the request was definitely not sent), or UNKNOWN (it may have been sent: timeout, error,
// crash, no usage reported) — UNKNOWN keeps the full reserved amount counted as spent, never as free.
// These are local estimates of calls through this app only: not the provider's bill, and they do not
// limit any other use of the provider account.

/** Calendar day for daily limits: Singapore time (UTC+08:00, no daylight saving). */
export const BUDGET_DAY_TIME_ZONE = "Asia/Singapore (UTC+08:00)";
export const BUDGET_DAY_OFFSET_MS = 8 * 3600_000;

export function budgetDay(at: Date): string {
  return new Date(at.getTime() + BUDGET_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

export type LedgerState = "RESERVED" | "SETTLED" | "RELEASED" | "UNKNOWN";

export interface BudgetTotals {
  /** Calls counted against the limit (everything except RELEASED). */
  calls: number;
  /** Σ estimates from reported usage (SETTLED). */
  settledMicros: number;
  /** Σ reserved upper bounds not settled: in flight (RESERVED) or outcome unknown (UNKNOWN). */
  pendingMicros: number;
  /** Of `calls`: attempts whose outcome is unknown (kept at their reserved amount). */
  unknownCount: number;
}

export interface BudgetLimits {
  totalMicros: number;
  dailyMicros: number;
  totalCalls: number;
  dailyCalls: number;
}

export type BudgetStatus =
  | {
      state: "NOT_CONFIGURED";
      /** Environment variable names only, never values. */
      missing: string[];
      problems: string[];
      /** Spend already recorded (per currency), shown even when no budget is configured. */
      recorded: { currency: string; today: BudgetTotals; total: BudgetTotals }[];
      day: string;
    }
  | {
      state: "CONFIGURED";
      currency: string;
      provider: string;
      model: string;
      limits: BudgetLimits;
      today: BudgetTotals;
      total: BudgetTotals;
      /** max(0, limit − settled − pending). */
      remainingTodayMicros: number;
      remainingTotalMicros: number;
      remainingTodayCalls: number;
      remainingTotalCalls: number;
      day: string;
      /** Spend recorded in another currency blocks real calls (nothing is converted). */
      otherCurrencies: string[];
    };

/** micro-units → "1.234567" trimmed to at least 2 decimals ("12.50", "0.000315"). */
export function formatMicros(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const v = Math.abs(micros);
  const whole = Math.floor(v / 1_000_000);
  let frac = String(v % 1_000_000).padStart(6, "0");
  while (frac.length > 2 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

/**
 * What a signed-in page may see of the global API budget (30 Oct, docs/access-control.md): only whether a real model
 * call could start now, with a short reason. Totals, limits, other users' spend, provider / model and configuration
 * names stay on the server. The ledger reservation at call time still decides.
 */
export interface BudgetAvailability {
  state: "AVAILABLE" | "UNAVAILABLE";
  reason: "NOT_CONFIGURED" | "DAILY_LIMIT_REACHED" | "TOTAL_LIMIT_REACHED" | "OTHER_CURRENCY_RECORDED" | null;
}

export function budgetAvailability(status: BudgetStatus): BudgetAvailability {
  if (status.state !== "CONFIGURED") return { state: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  if (status.otherCurrencies.length > 0) return { state: "UNAVAILABLE", reason: "OTHER_CURRENCY_RECORDED" };
  if (status.remainingTotalCalls <= 0 || status.remainingTotalMicros <= 0) return { state: "UNAVAILABLE", reason: "TOTAL_LIMIT_REACHED" };
  if (status.remainingTodayCalls <= 0 || status.remainingTodayMicros <= 0) return { state: "UNAVAILABLE", reason: "DAILY_LIMIT_REACHED" };
  return { state: "AVAILABLE", reason: null };
}
