// Extraction of one saved quote version, end to end. The caller names a request, series and version;
// everything sent to the model is read here from the database (the version's stored text, the version
// it supplements, the request snapshot it was saved with) — never taken from the browser.
//
// A run is started only by an explicit POST with a fresh idempotency key. Page loads, refreshes and
// language changes only read. Repeats with the same key replay; a second click while running gets the
// running row; a finished extraction is re-run only with `rerun: true`; a daily cap per version applies.

import { randomBytes } from "node:crypto";
import {
  EXTRACTION_LIMITS,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  type ExtractionConfigState,
  type ExtractionResult,
  type ExtractionReview,
  type ExtractionRun,
  type Fact,
  type ReviewAction,
  type SupplierRef,
} from "../../lib/extraction.ts";
import { budgetAvailability, type BudgetAvailability, type BudgetStatus } from "../../lib/budget.ts";
import { canReadRequest, canWriteRequest, type Principal } from "../access/policy.ts";
import { reservedInputTokens, resolveBudgetConfig, type BudgetConfig, type BudgetConfigResult } from "../budget/config.ts";
import { ledgerHooks } from "../budget/ledgered-call.ts";
import type { BudgetStore, LedgerRow } from "../budget/store.ts";
import { checkExtraction, parseModelOutput, resultStatus } from "./check.ts";
import { ModelCallError, callModel, resolveExtractionModel, type AttemptHooks, type ResolvedModel } from "./model.ts";
import { buildExtractionPrompt } from "./prompt.ts";
import { sha256, type BeginOutcome, type ExtractionStore, type NewReview, type ReviewOutcome, type VersionInput } from "./store.ts";

export interface VersionExtractions {
  config: ExtractionConfigState;
  version: { id: string; versionNumber: number; latestVersionNumber: number; contentKind: VersionInput["contentKind"]; rawTextSha256: string; requestRevision: number; snapshotItemIds: string[] };
  runs: ExtractionRun[];
  reviews: Record<string, ExtractionReview[]>;
  supplierRefs: SupplierRef[];
  limits: typeof EXTRACTION_LIMITS;
  /**
   * Whether a real model call could start now (null when no ledger is attached, e.g. in some tests). Only this is
   * shown to signed-in accounts (30 Oct): the ledger is global, so totals, limits and configuration stay on the server.
   */
  budget: BudgetAvailability | null;
  /** Budget ledger rows per run id (LIVE attempts only). */
  costs: Record<string, CostLine[]>;
}

export type CostLine = Pick<LedgerRow, "attempt" | "state" | "currency" | "reservedMicros" | "settledMicros" | "inputTokens" | "outputTokens" | "outcomeNote">;

export type RunOutcome =
  | { status: "NOT_FOUND" }
  | { status: "NOT_CONFIGURED"; config: ExtractionConfigState }
  | { status: "INPUT_TOO_LONG"; message: string }
  | { status: "BUDGET_NOT_CONFIGURED"; missing: string[]; problems: string[] }
  | Exclude<BeginOutcome, { status: "STARTED" }>
  | { status: "FINISHED"; run: ExtractionRun };

export type ReviewResult = { status: "NOT_FOUND" } | { status: "INVALID"; message: string } | ReviewOutcome;

export interface ServiceOptions {
  resolveModel?: () => ResolvedModel;
  nonce?: () => string;
  limits?: { timeoutMs: number; maxAttempts: number; retryDelayMs?: number };
  /** Overall API budget ledger. Without it, LIVE runs are refused (MOCK runs do not need it). */
  budget?: BudgetStore | null;
  resolveBudget?: (provider: string, model: string) => BudgetConfigResult;
}

const length = (s: string) => [...s].length;

/** Every reviewable fact path of a result, with its fact (".match" paths have no fact). */
export function reviewableFacts(result: ExtractionResult): Map<string, Fact<unknown> | null> {
  const out = new Map<string, Fact<unknown> | null>();
  result.supplierQuoteNumbers.forEach((f, i) => out.set(`supplierQuoteNumbers[${i}]`, f));
  for (const key of ["quoteDate", "currency", "total", "incoterm", "leadTime", "paymentTerms"] as const) out.set(key, result[key] as Fact<unknown>);
  result.items.forEach((item, i) => {
    for (const key of ["name", "quantity", "unit", "material", "specification", "logo", "unitPrice"] as const) out.set(`items[${i}].${key}`, item[key] as Fact<unknown>);
    out.set(`items[${i}].match`, null);
  });
  result.fees.forEach((fee, i) => {
    for (const key of ["kind", "description", "amount", "amountBasis", "payer", "payee", "includedInQuote", "statedAs"] as const) out.set(`fees[${i}].${key}`, fee[key] as Fact<unknown>);
  });
  return out;
}

export class ExtractionService {
  private readonly store: ExtractionStore;
  private readonly resolveModel: () => ResolvedModel;
  private readonly nonce: () => string;
  private readonly limits: { timeoutMs: number; maxAttempts: number; retryDelayMs?: number };
  private readonly budget: BudgetStore | null;
  private readonly resolveBudget: (provider: string, model: string) => BudgetConfigResult;

  constructor(store: ExtractionStore, options: ServiceOptions = {}) {
    this.store = store;
    this.resolveModel = options.resolveModel ?? (() => resolveExtractionModel());
    this.nonce = options.nonce ?? (() => randomBytes(8).toString("hex"));
    this.limits = options.limits ?? { timeoutMs: EXTRACTION_LIMITS.timeoutMs, maxAttempts: EXTRACTION_LIMITS.maxAttempts };
    this.budget = options.budget ?? null;
    this.resolveBudget = options.resolveBudget ?? ((provider, model) => resolveBudgetConfig(provider, model));
  }

  /** Overall budget for the LIVE model currently configured (read-only; MOCK never uses it). */
  budgetStatus(): BudgetStatus | null {
    if (!this.budget) return null;
    const cfg = this.config();
    const live = cfg.state === "READY" && cfg.mode === "LIVE";
    return this.budget.status(live ? this.resolveBudget(cfg.provider, cfg.model) : this.resolveBudget("", ""));
  }

  /** Configuration state for the page: variable names only, never values. */
  config(): ExtractionConfigState {
    return this.resolveModel().config;
  }

  /** Read-only: never starts a run. */
  list(principal: Principal, requestId: string, seriesId: string, versionId: string): VersionExtractions | null {
    if (!canReadRequest(principal, requestId)) return null;
    const input = this.store.versionInput(requestId, seriesId, versionId);
    if (!input) return null;
    const runs = this.store.listRuns(versionId);
    return {
      config: this.config(),
      version: {
        id: input.versionId,
        versionNumber: input.versionNumber,
        latestVersionNumber: input.latestVersionNumber,
        contentKind: input.contentKind,
        rawTextSha256: input.rawTextSha256,
        requestRevision: input.requestRevision,
        snapshotItemIds: input.snapshot.record.items.map((i) => i.id),
      },
      runs,
      reviews: Object.fromEntries(runs.map((r) => [r.id, this.store.reviews(r.id)])),
      supplierRefs: this.store.supplierRefs(versionId),
      limits: EXTRACTION_LIMITS,
      budget: (() => {
        const s = this.budgetStatus();
        return s ? budgetAvailability(s) : null;
      })(),
      costs: Object.fromEntries(
        runs.map((r) => [
          r.id,
          (this.budget?.listForExtraction(r.id) ?? []).map(({ attempt, state, currency, reservedMicros, settledMicros, inputTokens, outputTokens, outcomeNote }) => ({ attempt, state, currency, reservedMicros, settledMicros, inputTokens, outputTokens, outcomeNote })),
        ]),
      ),
    };
  }

  async run(principal: Principal, requestId: string, seriesId: string, versionId: string, body: { idempotencyKey: string; rerun: boolean }): Promise<RunOutcome> {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const input = this.store.versionInput(requestId, seriesId, versionId);
    if (!input) return { status: "NOT_FOUND" };
    const resolved = this.resolveModel();
    if (!resolved.model) return { status: "NOT_CONFIGURED", config: resolved.config };
    const model = resolved.model;
    // A real (LIVE) call needs an approved, complete budget and the ledger. MOCK runs never touch it.
    let budget: BudgetConfig | null = null;
    if (model.mode === "LIVE") {
      const cfg = this.resolveBudget(model.provider, model.model);
      if (!cfg.ok) return { status: "BUDGET_NOT_CONFIGURED", missing: cfg.missing, problems: cfg.problems };
      if (!this.budget) return { status: "BUDGET_NOT_CONFIGURED", missing: [], problems: ["The budget ledger is not available, so no real model call is made."] };
      if (!model.countInputTokens) return { status: "BUDGET_NOT_CONFIGURED", missing: [], problems: ["This model adapter cannot count input tokens, so no safe reservation can be made."] };
      budget = cfg.config;
    }

    if (length(input.rawText) > EXTRACTION_LIMITS.maxInputChars) {
      return { status: "INPUT_TOO_LONG", message: `This version has ${length(input.rawText)} characters; extraction accepts at most ${EXTRACTION_LIMITS.maxInputChars}. Nothing was sent.` };
    }
    const context = input.contentKind === "SUPPLEMENT" ? input.context : null;
    if (context && length(context.rawText) > EXTRACTION_LIMITS.maxContextChars) {
      return { status: "INPUT_TOO_LONG", message: `The version this supplement adds to has ${length(context.rawText)} characters; at most ${EXTRACTION_LIMITS.maxContextChars} can be given as context. Nothing was sent.` };
    }

    const begun = this.store.beginRun(input, {
      idempotencyKey: body.idempotencyKey,
      fingerprint: sha256(JSON.stringify([versionId, body.rerun])),
      mode: model.mode,
      provider: model.provider,
      model: model.model,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      rerun: body.rerun,
      dailyCap: model.mode === "LIVE" ? EXTRACTION_LIMITS.maxLiveRunsPerVersionPerDay : EXTRACTION_LIMITS.maxMockRunsPerVersionPerDay,
    });
    if (begun.status !== "STARTED") return begun;

    const snapshotItems = input.snapshot.record.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, material: i.material, specification: i.specification }));
    const prompt = buildExtractionPrompt({
      versionNumber: input.versionNumber,
      contentKind: input.contentKind,
      text: input.rawText,
      context: context ? { versionNumber: context.versionNumber, text: context.rawText } : null,
      snapshotItems,
      nonce: this.nonce(),
    });
    let hooks: AttemptHooks | undefined;
    if (budget) {
      // Reserve from the provider's own count of this exact request (+ margin). If it cannot be counted, nothing is sent.
      let counted: number;
      try {
        counted = await model.countInputTokens!({ system: prompt.system, user: prompt.user, maxOutputTokens: EXTRACTION_LIMITS.maxOutputTokens });
      } catch (err) {
        const code = err instanceof ModelCallError ? err.code : "UNEXPECTED";
        const message = err instanceof ModelCallError ? err.message : "Token counting failed unexpectedly.";
        const run = this.store.finishRun(begun.run.id, { status: "FAILED", errorCode: "TOKEN_COUNT_FAILED", errorMessage: `Could not count input tokens (${code}): ${message} Nothing was sent; no budget was reserved.`.slice(0, 1000), attempts: 0, inputTokens: null, outputTokens: null, rawOutput: null, result: null });
        return { status: "FINISHED", run };
      }
      hooks = this.budgetHooks(budget, begun.run.id, reservedInputTokens(counted), EXTRACTION_LIMITS.maxOutputTokens);
    }
    const call = await callModel(
      model,
      { system: prompt.system, user: prompt.user, maxOutputTokens: EXTRACTION_LIMITS.maxOutputTokens, mockInput: { text: input.rawText, snapshotItems } },
      this.limits,
      hooks,
    );
    if (!call.ok) {
      const run = this.store.finishRun(begun.run.id, {
        status: "FAILED",
        errorCode: call.code,
        errorMessage: call.message,
        attempts: call.attempts,
        inputTokens: call.usage?.inputTokens ?? null,
        outputTokens: call.usage?.outputTokens ?? null,
        rawOutput: null,
        result: null,
      });
      return { status: "FINISHED", run };
    }
    const reply = call.reply;
    const usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
    if (reply.stopReason === "refusal") {
      const run = this.store.finishRun(begun.run.id, { status: "FAILED", errorCode: "REFUSED", errorMessage: "The model declined this request (stop reason: refusal). Nothing from it was used; no other model was tried.", attempts: call.attempts, ...usage, rawOutput: reply.text || null, result: null });
      return { status: "FINISHED", run };
    }
    if (reply.truncated) {
      const run = this.store.finishRun(begun.run.id, { status: "FAILED", errorCode: "OUTPUT_TRUNCATED", errorMessage: "The model's reply hit the output limit and is incomplete; nothing from it was used.", attempts: call.attempts, ...usage, rawOutput: reply.text, result: null });
      return { status: "FINISHED", run };
    }
    const parsed = parseModelOutput(reply.text);
    if (!parsed.ok) {
      const run = this.store.finishRun(begun.run.id, {
        status: "FAILED",
        errorCode: "INVALID_OUTPUT",
        errorMessage: `The model's reply did not have the required structure; nothing from it was used. ${parsed.problems.slice(0, 3).join("; ")}`.slice(0, 1000),
        attempts: call.attempts,
        ...usage,
        rawOutput: reply.text,
        result: null,
      });
      return { status: "FINISHED", run };
    }
    const result = checkExtraction(parsed.value, {
      text: input.rawText,
      contextText: context?.rawText ?? null,
      contentKind: input.contentKind,
      snapshotItemIds: new Set(snapshotItems.map((i) => i.id)),
    });
    const run = this.store.finishRun(begun.run.id, { status: resultStatus(result), errorCode: null, errorMessage: null, attempts: call.attempts, ...usage, rawOutput: reply.text, result });
    return { status: "FINISHED", run };
  }

  /** Budget hooks for one run: the shared ledgered call (budget/ledgered-call.ts), keys `<run id>#<attempt>`. */
  private budgetHooks(budget: BudgetConfig, runId: string, inputTokensBound: number, outputTokensBound: number): AttemptHooks {
    return ledgerHooks(this.budget!, budget, { requestKeyBase: runId, purpose: "QUOTE_EXTRACTION", extractionId: runId, copilotRequestId: null, inputTokensBound, outputTokensBound });
  }

  review(
    principal: Principal,
    requestId: string,
    seriesId: string,
    versionId: string,
    extractionId: string,
    input: NewReview,
  ): ReviewResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const version = this.store.versionInput(requestId, seriesId, versionId);
    const run = this.store.getRun(extractionId);
    if (!version || !run || run.versionId !== versionId) return { status: "NOT_FOUND" };
    if (!run.result) return { status: "INVALID", message: "This run has no result to review." };
    const facts = reviewableFacts(run.result);
    if (!facts.has(input.fieldPath)) return { status: "INVALID", message: "Unknown field for this extraction." };
    const fact = facts.get(input.fieldPath)!;
    const isMatch = input.fieldPath.endsWith(".match");
    const allowed: ReviewAction[] = isMatch ? ["MATCH_ITEM", "NO_MATCH"] : ["CONFIRM", "REJECT", "CORRECT"];
    if (!allowed.includes(input.action)) return { status: "INVALID", message: `Allowed here: ${allowed.join(", ")}.` };
    if (input.action === "CONFIRM" && fact?.check !== "SUPPORTED") {
      return { status: "INVALID", message: "Only a value supported by the text can be confirmed. Use Correct to enter the value yourself." };
    }
    if (input.action === "MATCH_ITEM") {
      // The line must belong to the snapshot this version was saved with — not today's request.
      const ids = new Set(version.snapshot.record.items.map((i) => i.id));
      if (!input.requestItemId || !ids.has(input.requestItemId)) return { status: "INVALID", message: "That item is not a line of the request snapshot linked to this version." };
    }
    let supplierRef: Parameters<ExtractionStore["addReview"]>[2] = null;
    if (input.fieldPath.startsWith("supplierQuoteNumbers[")) {
      if (input.action === "CONFIRM") supplierRef = { origin: "USER_CONFIRMED", value: String(fact!.value), evidence: fact!.evidence!.excerpt };
      else if (input.action === "CORRECT") {
        if (length(input.valueText ?? "") > 100) return { status: "INVALID", message: "A supplier quote number has at most 100 characters." };
        supplierRef = { origin: "USER_ENTERED", value: input.valueText, evidence: null };
      } else {
        // Rejecting a number the user had confirmed clears it; a rejected candidate is never the value.
        const current = this.store.supplierRefs(versionId).filter((r) => r.origin !== "AI_CANDIDATE").at(-1);
        if (current && current.valueRaw !== null && current.valueRaw === fact?.value) supplierRef = { origin: "USER_CLEARED", value: null, evidence: null };
      }
    }
    return this.store.addReview(run, input, supplierRef);
  }
}
