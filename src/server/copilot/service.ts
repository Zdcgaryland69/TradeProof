// Copilot ask flow (2 Nov; plan §4.2, §6). One ask = one button press with a fresh request key:
//   1. authorise (canReadRequest) — refused → same 404 as a missing id; nothing gathered, nothing sent;
//   2. build the facts (read-only) and the basis;
//   3. explanation: none / MOCK / LIVE. LIVE needs the server switch TRADEPROOF_COPILOT_LIVE=on, a configured approved
//      budget and token counting; then ONE ledgered attempt (purpose COPILOT_ANSWER, the same global limits as
//      extraction, no SDK retry, no application retry, no re-ask after invalid / truncated output);
//   4. authorise AGAIN from the cookie after the model returns (same account, still allowed) — otherwise no answer text;
//   5. recompute the basis; a different basis → the answer is marked OUTDATED (never shown as current), never re-asked.
// Writes: only the ledger row of a LIVE attempt (reserve → settle / release / unknown). No business table is written,
// and answers are not stored. Repeats of the same request key never call again: in-process they get the first result;
// across processes and after a restart the ledger (an exclusive key prefix checked inside the reservation's write
// transaction) refuses a second call: same request → ALREADY_ASKED with the first call's ledger state; same key with
// another question / version / basis → KEY_REUSED. Different keys are different requests and are counted as such.

import { createHash } from "node:crypto";
import { COPILOT_LIMITS, COPILOT_QUESTIONS, changedParts, type CopilotAnswer, type CopilotExplanation, type CopilotIntent } from "../../lib/copilot.ts";
import { canReadRequest, type Principal } from "../access/policy.ts";
import { reservedInputTokens, resolveBudgetConfig, type BudgetConfigResult } from "../budget/config.ts";
import { ledgerHooks } from "../budget/ledgered-call.ts";
import type { BudgetStore } from "../budget/store.ts";
import { callModel, ModelCallError, resolveExtractionModel, type ResolvedModel } from "../extraction/model.ts";
import { COPILOT_FACTS_VERSION, buildCopilot, basisFor, type Built, type CopilotSources, type Selection } from "./facts.ts";
import { COPILOT_MOCK, mockExplanation } from "./mock.ts";
import { COPILOT_PROMPT_VERSION, buildCopilotPrompt } from "./prompt.ts";
import { COPILOT_VALIDATOR_VERSION, validateExplanation } from "./validate.ts";

export interface CopilotOptions {
  resolveModel?: () => ResolvedModel;
  /** TRADEPROOF_COPILOT_LIVE=on, read per ask. Without it no real model is called by the Copilot. */
  liveEnabled?: () => boolean;
  budget?: BudgetStore | null;
  resolveBudget?: (provider: string, model: string) => BudgetConfigResult;
  /** MOCK only (tests): the canned "model output" for a bundle. Default: re-state the facts. */
  mockOutput?: (input: { intent: CopilotIntent; built: Built }) => string;
  /** Extra per-ask reservation ceiling (micro-units), e.g. what is left of an owner-authorised run cap. */
  runCapMicros?: () => number | null;
  limits?: { timeoutMs: number };
  /**
   * Evidence sink for an owner-authorised acceptance RUN only (scripts/copilot-live-acceptance.mts). The app never sets
   * it: answers are not stored. Receives the bundle, prompt, raw output, validation and ledger outcome of each ask
   * that reached the explanation step. Contains no key, cookie or session token.
   */
  onEvidence?: (e: CopilotEvidence) => void;
}

export interface CopilotEvidence {
  intent: CopilotIntent;
  requestId: string;
  rules: { facts: string; prompt: string; validator: string };
  basis: Built["basis"];
  resolved: Built["resolved"];
  facts: Built["facts"];
  links: Built["links"];
  prompt: { system: string; user: string; bundleChars: number; utf8Bytes: number } | null;
  model: { mode: "LIVE" | "MOCK"; provider: string; model: string } | null;
  tokenCount: number | null;
  ledgerKey: string | null;
  ledgerRowId: string | null;
  rawOutput: string | null;
  stopReason: string | null;
  truncated: boolean | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  validation: { ok: boolean; problems: string[] } | null;
  outcome: CopilotExplanation | { kind: "KEY_REUSED" };
}

type ExplainResult = CopilotExplanation | { kind: "KEY_REUSED" };

/** Why a repeated click key gets no second call, from the ledger state of the first one (restart-safe). */
export const ALREADY_ASKED_DETAIL: Record<string, string> = {
  RESERVED: "IN_PROGRESS — the first request of this click is still running or was interrupted; it is not sent again.",
  SETTLED: "ANSWER_NOT_KEPT — this click was already answered and its cost recorded; answers are not stored. Ask again with a new click (a new, counted call).",
  UNKNOWN: "OUTCOME_UNKNOWN — the first request may have been processed; its reserved cost stays counted. It is not sent again.",
  RELEASED: "NOT_SENT — the first request of this click was not sent. Ask again with a new click.",
};

export type AskOutcome =
  | { status: "NOT_FOUND" }
  | { status: "UNAUTHENTICATED" }
  | { status: "KEY_REUSED" }
  | { status: "OK"; answer: CopilotAnswer };

interface Asked {
  scope: string;
  bind: string;
  promise: Promise<{ explanation: ExplainResult; built: Built }>;
  at: number;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const accountHash = (principalId: string) => sha(`copilot-account\n${principalId}`).slice(0, 16);
const CACHE_MS = 15 * 60_000;
const CACHE_MAX = 200;

export class CopilotService {
  private readonly src: CopilotSources;
  private readonly o: Required<Pick<CopilotOptions, "resolveModel" | "liveEnabled" | "resolveBudget">> & CopilotOptions;
  private readonly asked = new Map<string, Asked>();
  /** Counters for tests: how many model / token-count calls the Copilot made. */
  readonly calls = { complete: 0, count: 0 };

  constructor(src: CopilotSources, options: CopilotOptions = {}) {
    this.src = src;
    this.o = {
      ...options,
      resolveModel: options.resolveModel ?? (() => resolveExtractionModel()),
      liveEnabled: options.liveEnabled ?? (() => (process.env.TRADEPROOF_COPILOT_LIVE ?? "").trim() === "on"),
      resolveBudget: options.resolveBudget ?? ((p, m) => resolveBudgetConfig(p, m)),
    };
  }

  /** What the panel may know before asking (no call): which kind of explanation an ask would get. */
  mode(): { kind: "LIVE" | "MOCK" | "NONE"; reason: string | null } {
    const r = this.o.resolveModel();
    if (!r.model) return { kind: "NONE", reason: "NO_MODEL" };
    if (r.model.mode === "MOCK") return { kind: "MOCK", reason: null };
    if (!this.o.liveEnabled()) return { kind: "NONE", reason: "LIVE_NOT_AUTHORISED" };
    return { kind: "LIVE", reason: null };
  }

  basis(principal: Principal, requestId: string, sel: Selection) {
    return basisFor(this.src, principal, requestId, sel);
  }

  /**
   * `reauthorise` re-resolves the principal from the request's session cookie AFTER the model returned (null = signed
   * out / session gone). `key` is the browser's per-click request key (UUID), `nonce` echoes in `answerFor`.
   */
  async ask(principal: Principal, requestId: string, sel: Selection, intent: CopilotIntent, key: string, nonce: string, reauthorise: () => Principal | null): Promise<AskOutcome> {
    if (!canReadRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const built = buildCopilot(this.src, principal, requestId, sel, intent);
    if (!built) return { status: "NOT_FOUND" };
    this.prune();
    // Idempotency scope: account + record + request key. The answer is reused only for the same intent, version, run
    // and basis; the same key with anything else is refused (never a second call, never another account's answer).
    const scope = sha(`copilot-ask\n${principal.id}\n${requestId}\n${key}`).slice(0, 32);
    const bind = sha(`${intent}\n${built.resolved.versionId}\n${built.resolved.runId}\n${built.basis.digest}`);
    let entry = this.asked.get(scope);
    let repeat = false;
    if (entry) {
      if (entry.bind !== bind) return { status: "KEY_REUSED" };
      repeat = true;
    } else {
      entry = { scope, bind, at: Date.now(), promise: this.explain(intent, built, scope, bind, requestId)
          .catch((err): ExplainResult => {
            // Unexpected failure (e.g. the ledger could not be closed): the call may have been sent; never re-sent.
            console.error("[copilot] explanation failed unexpectedly", err instanceof Error ? err.message : String(err));
            return { kind: "NONE", reason: "MODEL_ERROR", detail: "UNEXPECTED" };
          })
          .then((explanation) => ({ explanation, built })) };
      this.asked.set(scope, entry);
    }
    const { explanation: result } = await entry.promise;
    if (result.kind === "KEY_REUSED") {
      this.asked.delete(scope);
      return { status: "KEY_REUSED" };
    }
    const explanation = result;

    // Re-authorise after the model returned: the session may be gone, the account switched or access removed.
    const again = reauthorise();
    if (!again) return { status: "UNAUTHENTICATED" };
    if (again.id !== principal.id || !canReadRequest(again, requestId)) return { status: "NOT_FOUND" };
    const now = buildCopilot(this.src, again, requestId, sel, intent);
    if (!now) return { status: "NOT_FOUND" };
    const changed = changedParts(built.basis, now.basis);
    // Facts shown are the ones the explanation was made from (citations must resolve); "OUTDATED" says they are old.
    return {
      status: "OK",
      answer: {
        intent,
        question: COPILOT_QUESTIONS[intent],
        facts: built.facts,
        links: built.links,
        nextStep: built.nextStep,
        notices: built.notices,
        explanation,
        basis: built.basis,
        status: changed.length === 0 ? "CURRENT" : "OUTDATED",
        changed,
        repeat,
        answerFor: { account: accountHash(principal.id), requestId, ...built.resolved, intent, nonce },
      },
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.asked) if (now - v.at > CACHE_MS) this.asked.delete(k);
    while (this.asked.size > CACHE_MAX) this.asked.delete(this.asked.keys().next().value!);
  }

  private async explain(intent: CopilotIntent, built: Built, scope: string, bind: string, requestId: string): Promise<ExplainResult> {
    const ev: CopilotEvidence = {
      intent,
      requestId,
      rules: { facts: COPILOT_FACTS_VERSION, prompt: COPILOT_PROMPT_VERSION, validator: COPILOT_VALIDATOR_VERSION },
      basis: built.basis,
      resolved: built.resolved,
      facts: built.facts,
      links: built.links,
      prompt: null,
      model: null,
      tokenCount: null,
      ledgerKey: null,
      ledgerRowId: null,
      rawOutput: null,
      stopReason: null,
      truncated: null,
      usage: null,
      validation: null,
      outcome: { kind: "NONE", reason: "NO_MODEL", detail: null },
    };
    const outcome = await this.explainInner(intent, built, scope, bind, requestId, ev);
    ev.outcome = outcome;
    try {
      this.o.onEvidence?.(ev);
    } catch (err) {
      console.error("[copilot] evidence sink failed", err instanceof Error ? err.message : String(err));
    }
    return outcome;
  }

  private async explainInner(intent: CopilotIntent, built: Built, scope: string, bind: string, requestId: string, ev: CopilotEvidence): Promise<ExplainResult> {
    const none = (reason: Extract<CopilotExplanation, { kind: "NONE" }>["reason"], detail: string | null = null): CopilotExplanation => ({ kind: "NONE", reason, detail });
    // The prompt is built (pure, nothing sent) before the model check so the evidence of a dry run shows it too.
    const prompt = buildCopilotPrompt(intent, built.facts, built.links);
    ev.prompt = { system: prompt.system, user: prompt.user, bundleChars: prompt.bundleChars, utf8Bytes: Buffer.byteLength(prompt.system, "utf8") + Buffer.byteLength(prompt.user, "utf8") };
    const resolved = this.o.resolveModel();
    if (!resolved.model) return none("NO_MODEL");
    const model = resolved.model;
    ev.model = { mode: model.mode, provider: model.provider, model: model.model };
    if (prompt.bundleChars > COPILOT_LIMITS.maxBundleChars) return none("BUNDLE_TOO_LARGE", `${prompt.bundleChars} characters; at most ${COPILOT_LIMITS.maxBundleChars}.`);
    const check = (raw: string, kind: "LIVE" | "MOCK", provider: string, modelName: string): CopilotExplanation => {
      const v = validateExplanation(raw, { intent, facts: built.facts, links: built.links });
      ev.validation = { ok: v.ok, problems: v.ok ? [] : v.problems };
      return v.ok ? { kind, provider, model: modelName, sentences: v.sentences, nextStep: v.nextStep } : none("FAILED_CHECK", v.problems.slice(0, 8).join("; "));
    };

    if (model.mode === "MOCK") {
      const raw = this.o.mockOutput ? this.o.mockOutput({ intent, built }) : mockExplanation(intent, built.facts, built.links, built.nextStep?.link ?? null);
      ev.rawOutput = raw;
      return check(raw, "MOCK", COPILOT_MOCK.provider, COPILOT_MOCK.model);
    }

    // ---- LIVE: only with the explicit server switch, an approved budget, the ledger and token counting. ----
    if (!this.o.liveEnabled()) return none("LIVE_NOT_AUTHORISED");
    const cfg = this.o.resolveBudget(model.provider, model.model);
    if (!cfg.ok || !this.o.budget || !model.countInputTokens) return none("BUDGET_NOT_CONFIGURED");
    const ledger = this.o.budget;
    // Ledger key = account + record + click key (the exclusive prefix) + the question / version / run / basis binding.
    // The prefix check runs again inside the reservation's write transaction, so across processes and restarts a click
    // key gets at most one reservation and therefore at most one model request.
    const prefix = `copilot:${scope}:`;
    const requestKeyBase = `${prefix}${bind.slice(0, 16)}`;
    ev.ledgerKey = `${requestKeyBase}#1`;
    const repeated = (row: { requestKey: string; state: string } | null): ExplainResult | null =>
      row ? (row.requestKey === `${requestKeyBase}#1` ? none("ALREADY_ASKED", ALREADY_ASKED_DETAIL[row.state] ?? row.state) : { kind: "KEY_REUSED" }) : null;
    const before = repeated(ledger.firstWithPrefix(prefix));
    if (before) return before;
    let counted: number;
    try {
      this.calls.count += 1;
      counted = await model.countInputTokens({ system: prompt.system, user: prompt.user, maxOutputTokens: COPILOT_LIMITS.maxOutputTokens });
      ev.tokenCount = counted;
    } catch (err) {
      return none("TOKEN_COUNT_FAILED", err instanceof ModelCallError ? err.code : "UNEXPECTED");
    }
    const cap = this.o.runCapMicros?.();
    const hooks = ledgerHooks(ledger, cfg.config, {
      requestKeyBase,
      uniquePrefix: prefix,
      purpose: "COPILOT_ANSWER",
      extractionId: null,
      copilotRequestId: requestId,
      inputTokensBound: reservedInputTokens(counted),
      outputTokensBound: COPILOT_LIMITS.maxOutputTokens,
      maxReservedMicros: cap === null || cap === undefined ? COPILOT_LIMITS.maxReservedMicros : Math.min(cap, COPILOT_LIMITS.maxReservedMicros),
    });
    const counting = { ...model, complete: (r: Parameters<typeof model.complete>[0]) => ((this.calls.complete += 1), model.complete(r)) };
    const call = await callModel(counting, { system: prompt.system, user: prompt.user, maxOutputTokens: COPILOT_LIMITS.maxOutputTokens }, { timeoutMs: this.o.limits?.timeoutMs ?? COPILOT_LIMITS.timeoutMs, maxAttempts: COPILOT_LIMITS.maxAttempts }, hooks);
    ev.ledgerRowId = hooks.rows.get(1) ?? null;
    if (!call.ok) {
      ev.usage = call.usage ?? null;
      if (call.code === "BUDGET_DUPLICATE") return repeated(ledger.firstWithPrefix(prefix)) ?? none("ALREADY_ASKED");
      if (call.code.startsWith("BUDGET_")) return none("BUDGET_REFUSED", call.message);
      if (call.code === "TIMEOUT") return none("TIMEOUT");
      return none("MODEL_ERROR", call.code);
    }
    ev.rawOutput = call.reply.text;
    ev.stopReason = call.reply.stopReason ?? null;
    ev.truncated = call.reply.truncated;
    ev.usage = { inputTokens: call.reply.inputTokens, outputTokens: call.reply.outputTokens };
    if (call.reply.stopReason === "refusal") return none("REFUSED");
    if (call.reply.truncated) return none("OUTPUT_TRUNCATED");
    return check(call.reply.text, "LIVE", model.provider, model.model);
  }
}
