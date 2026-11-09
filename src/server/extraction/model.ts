// The model behind extraction: a small provider-neutral interface, the configuration check, the
// call policy (timeout, one retry for clearly transient errors) and a MOCK used for local tests.
//
// No live provider adapter exists yet: the owner has not chosen a provider, model or spending limit,
// so nothing here can make a paid call. resolveExtractionModel reports which variables are missing
// (names only, never values). AI_PROVIDER=mock selects canned SYNTHETIC outputs, labelled MOCK
// everywhere and never presented as an AI result.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXTRACTION_LIMITS, type ExtractionConfigState } from "../../lib/extraction.ts";
import { ANTHROPIC_APPROVED_MODELS, AnthropicExtractionModel } from "./anthropic.ts";

export interface ModelRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Structured copy of the input for MOCK models only; a live adapter sends system + user and ignores this. */
  mockInput?: { text: string; snapshotItems: { id: string; name: string }[] };
}

export interface ModelReply {
  text: string;
  /** The reply stopped at the output limit. */
  truncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Provider stop reason as reported (e.g. "end_turn", "max_tokens", "refusal"); null when not reported. */
  stopReason?: string | null;
  /** Provider request id (for audit / support); never a secret. */
  requestId?: string | null;
  /**
   * Set when the reported usage is not enough to price the reply at the configured prices (e.g. cache
   * tokens or a non-global inference region). The budget then keeps the full reservation (UNKNOWN).
   */
  billingNote?: string | null;
}

export interface ExtractionModel {
  readonly mode: "LIVE" | "MOCK";
  readonly provider: string;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelReply>;
  /**
   * Input tokens of exactly this request, from the provider's own counting (LIVE adapters must provide it:
   * the budget reserves from it). Free and unbilled where the provider says so; never generates output.
   */
  countInputTokens?(request: Omit<ModelRequest, "signal" | "mockInput">): Promise<number>;
}

export { ModelCallError, type ModelErrorCode } from "./model-error.ts";
import { ModelCallError } from "./model-error.ts";

// ---------- configuration ----------

/**
 * Live provider adapters and the models the owner approved for each (25 Oct: Anthropic, Claude Sonnet 5.5,
 * USD budget). Any other model name is refused, so changing AI_MODEL cannot switch to another paid model.
 */
const LIVE_ADAPTERS: Record<string, { approvedModels: readonly string[]; create: (model: string, apiKey: string) => ExtractionModel }> = {
  anthropic: { approvedModels: ANTHROPIC_APPROVED_MODELS, create: (model, apiKey) => new AnthropicExtractionModel(model, apiKey) },
};

export type ResolvedModel = { config: ExtractionConfigState & { state: "NOT_CONFIGURED" }; model: null } | { config: ExtractionConfigState & { state: "READY" }; model: ExtractionModel };

export function resolveExtractionModel(env: Record<string, string | undefined> = process.env, root: string = process.cwd()): ResolvedModel {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "mock") {
    if (env.NODE_ENV === "production") {
      return { config: { state: "NOT_CONFIGURED", missing: [], message: "MOCK mode is for local development only." }, model: null };
    }
    const model = new MockExtractionModel(root);
    return { config: { state: "READY", mode: "MOCK", provider: model.provider, model: model.model }, model };
  }
  const missing = ["AI_PROVIDER", "AI_MODEL", "AI_API_KEY"].filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    return {
      config: { state: "NOT_CONFIGURED", missing, message: "No AI model is configured, so no extraction can run and nothing is sent anywhere." },
      model: null,
    };
  }
  const adapter = LIVE_ADAPTERS[provider];
  if (!adapter) {
    return {
      config: {
        state: "NOT_CONFIGURED",
        missing: [],
        message: `No adapter for provider "${provider}" exists yet. A real model is connected only after the owner approves the provider, model and spending limit.`,
      },
      model: null,
    };
  }
  const modelName = env.AI_MODEL!.trim();
  if (!adapter.approvedModels.includes(modelName)) {
    return {
      config: { state: "NOT_CONFIGURED", missing: [], message: `Model "${modelName}" is not approved for provider "${provider}". Approved: ${adapter.approvedModels.join(", ")}. Nothing is sent.` },
      model: null,
    };
  }
  const model = adapter.create(modelName, env.AI_API_KEY!.trim());
  return { config: { state: "READY", mode: "LIVE", provider: model.provider, model: model.model }, model };
}

// ---------- call policy ----------

export type CallOutcome =
  | { ok: true; reply: ModelReply; attempts: number }
  | { ok: false; code: string; message: string; attempts: number; usage?: { inputTokens: number | null; outputTokens: number | null } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What happened to one attempt, for the budget ledger. */
export type AttemptOutcome =
  | { kind: "REPLY"; inputTokens: number | null; outputTokens: number | null; billingNote: string | null; requestId: string | null }
  | { kind: "ERROR"; code: string; notSent: boolean }
  | { kind: "TIMEOUT" };

/**
 * Budget hooks (LIVE only). `beforeAttempt` runs before each attempt and must return `{ ok: true }`
 * (an upper bound was reserved) for the request to be sent; anything else stops without sending.
 * `afterAttempt` closes that reservation exactly once.
 */
export interface AttemptHooks {
  beforeAttempt(attempt: number): { ok: true } | { ok: false; code: string; message: string };
  afterAttempt(attempt: number, outcome: AttemptOutcome): void;
}

/**
 * At most EXTRACTION_LIMITS.maxAttempts attempts. Only a retryable ModelCallError is retried (after a
 * short pause). A timeout is never retried: the provider may still have processed (and billed) it.
 * With hooks, every attempt needs its own budget reservation first; a refused retry is not sent.
 */
export async function callModel(
  model: ExtractionModel,
  request: Omit<ModelRequest, "signal">,
  limits: { timeoutMs: number; maxAttempts: number; retryDelayMs?: number } = { timeoutMs: EXTRACTION_LIMITS.timeoutMs, maxAttempts: EXTRACTION_LIMITS.maxAttempts },
  hooks?: AttemptHooks,
): Promise<CallOutcome> {
  let lastError: Extract<CallOutcome, { ok: false }> | null = null;
  for (let attempt = 1; ; attempt++) {
    if (hooks) {
      const gate = hooks.beforeAttempt(attempt);
      if (!gate.ok) {
        if (lastError) return { ...lastError, message: `${lastError.message} Retry not sent: ${gate.message}`.slice(0, 500) };
        return { ok: false, code: gate.code, message: gate.message, attempts: 0 };
      }
    }
    const outcome = await attemptOnce(model, request, limits, attempt);
    hooks?.afterAttempt(attempt, outcome.budget);
    if (outcome.retry && attempt < limits.maxAttempts) {
      lastError = outcome.result as Extract<CallOutcome, { ok: false }>;
      await sleep(limits.retryDelayMs ?? 1000);
      continue;
    }
    return outcome.result;
  }
}

async function attemptOnce(
  model: ExtractionModel,
  request: Omit<ModelRequest, "signal">,
  limits: { timeoutMs: number },
  attempt: number,
): Promise<{ result: CallOutcome; budget: AttemptOutcome; retry: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("TIMEOUT");
    }, limits.timeoutMs);
  });
  try {
    const result = await Promise.race([model.complete({ ...request, signal: controller.signal }), timeout]);
    if (result === "TIMEOUT") {
      return {
        result: { ok: false, code: "TIMEOUT", message: `No reply within ${Math.round(limits.timeoutMs / 1000)} s. Not retried automatically (the provider may still have processed it).`, attempts: attempt },
        budget: { kind: "TIMEOUT" },
        retry: false,
      };
    }
    return { result: { ok: true, reply: result, attempts: attempt }, budget: { kind: "REPLY", inputTokens: result.inputTokens, outputTokens: result.outputTokens, billingNote: result.billingNote ?? null, requestId: result.requestId ?? null }, retry: false };
  } catch (err) {
    if (err instanceof ModelCallError) {
      return {
        result: { ok: false, code: err.code, message: err.message.slice(0, 500), attempts: attempt },
        budget: { kind: "ERROR", code: err.code, notSent: err.notSent },
        retry: err.retryable,
      };
    }
    return { result: { ok: false, code: "UNEXPECTED", message: "The model call failed unexpectedly.", attempts: attempt }, budget: { kind: "ERROR", code: "UNEXPECTED", notSent: false }, retry: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- MOCK ----------

interface MockFixture {
  _notice: string;
  /** SHA-256 of the SYNTHETIC demo text (LF line endings) this canned output belongs to. */
  textSha256: string;
  /** Mock-only stand-in for matching: request items whose name matches this pattern become candidates. */
  matchNamePattern: string;
  output: Record<string, unknown>;
}

// Literal paths (not built from data) so the bundler traces only these two files.
const MOCK_FIXTURES: ((root: string) => string)[] = [
  (root) => readFileSync(path.join(root, "samples", "synthetic", "mock-model-output-zh.synthetic.json"), "utf8"),
  (root) => readFileSync(path.join(root, "samples", "synthetic", "mock-model-output-en.synthetic.json"), "utf8"),
  // 3 Nov: revised sample-order quote (USD 68.00, 100 % before shipment) so a MOCK demo can reach approval + MOCK payment.
  (root) => readFileSync(path.join(root, "samples", "synthetic", "mock-model-output-revised.synthetic.json"), "utf8"),
];

/**
 * Canned outputs for the three SYNTHETIC demo quotes only (zh, en, revised sample order). Not an AI: it cannot read any other text and
 * fails honestly (MOCK_NO_FIXTURE) instead of inventing a result.
 */
export class MockExtractionModel implements ExtractionModel {
  readonly mode = "MOCK" as const;
  readonly provider = "mock";
  readonly model = "canned-synthetic-v1";
  private readonly fixtures: MockFixture[];

  constructor(root: string = process.cwd()) {
    this.fixtures = [];
    for (const readFixture of MOCK_FIXTURES) {
      try {
        this.fixtures.push(JSON.parse(readFixture(root)) as MockFixture);
      } catch {
        // missing fixture: that sample simply has no canned output
      }
    }
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    const input = request.mockInput;
    if (!input) throw new ModelCallError("MOCK_NO_FIXTURE", false, "MOCK model received no input.");
    const sha = createHash("sha256").update(input.text, "utf8").digest("hex");
    const fixture = this.fixtures.find((f) => f.textSha256 === sha);
    if (!fixture) {
      throw new ModelCallError("MOCK_NO_FIXTURE", false, "MOCK mode only has canned output for the three SYNTHETIC demo quotes (Load demo). This text has none, so nothing was extracted. No AI was called.");
    }
    const pattern = new RegExp(fixture.matchNamePattern, "i");
    const candidates = input.snapshotItems.filter((i) => pattern.test(i.name)).map((i) => i.id);
    const output = structuredClone(fixture.output) as { items?: { requestItemCandidates?: string[] }[] };
    for (const item of output.items ?? []) item.requestItemCandidates = candidates;
    const text = JSON.stringify(output);
    return { text, truncated: false, inputTokens: null, outputTokens: null };
  }
}
