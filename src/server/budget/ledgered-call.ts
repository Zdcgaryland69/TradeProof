// The one ledgered call path for LIVE model attempts (moved out of ExtractionService on 2 Nov, gap G6), shared by
// quote extraction and the Copilot. Behaviour for extraction is unchanged; the Copilot uses the same reservation,
// close-once and unknown-outcome rules against the same global limits (purpose COPILOT_ANSWER, schema v18).
//
// One reservation per attempt, keyed `<requestKeyBase>#<attempt>` (a repeated key is never sent again).
// The bound covers the complete prompt (system + user) and the output cap.
// After the attempt: usage reported → SETTLED estimate; definitely not sent → RELEASED; anything
// else (timeout, error, no usage) → UNKNOWN, keeping the full reservation counted.
// A ledger that cannot be written before the attempt (e.g. still locked after the busy timeout) is a
// refusal: the attempt is definitely not sent, and nothing is retried. Errors after an attempt are not caught
// here (the request may have been sent).

import type { AttemptHooks } from "../extraction/model.ts";
import { boundMicros, type BudgetConfig } from "./config.ts";
import type { BudgetStore, LedgerPurpose } from "./store.ts";

export interface LedgeredCall {
  /** `<base>#<attempt>` is the ledger request key of each attempt. */
  requestKeyBase: string;
  /** See NewReservation.uniquePrefix. */
  uniquePrefix?: string;
  purpose: LedgerPurpose;
  extractionId: string | null;
  copilotRequestId: string | null;
  inputTokensBound: number;
  outputTokensBound: number;
  /**
   * Optional extra ceiling for ONE attempt's reservation (micro-units). Above it nothing is reserved or sent
   * (Copilot: a per-ask cap, and the owner-authorised run cap during a real acceptance run).
   */
  maxReservedMicros?: number | null;
}

export interface LedgerHooks extends AttemptHooks {
  /** Ledger row id of each attempt that got a reservation. */
  readonly rows: ReadonlyMap<number, string>;
}

export function ledgerHooks(ledger: BudgetStore, budget: BudgetConfig, call: LedgeredCall): LedgerHooks {
  const ids = new Map<number, string>();
  return {
    rows: ids,
    beforeAttempt: (attempt) => {
      const key = `${call.requestKeyBase}#${attempt}`;
      if (call.maxReservedMicros !== undefined && call.maxReservedMicros !== null) {
        const bound = boundMicros(budget.prices, call.inputTokensBound, call.outputTokensBound);
        if (bound > call.maxReservedMicros) {
          return { ok: false, code: "BUDGET_CAP", message: `This call's upper-bound cost is above the cap for this kind of call, so nothing was reserved or sent.` };
        }
      }
      let r: ReturnType<BudgetStore["reserve"]>;
      try {
        r = ledger.reserve(budget, {
          requestKey: key,
          uniquePrefix: call.uniquePrefix,
          purpose: call.purpose,
          extractionId: call.extractionId,
          copilotRequestId: call.copilotRequestId,
          attempt,
          inputTokensBound: call.inputTokensBound,
          outputTokensBound: call.outputTokensBound,
        });
      } catch (err) {
        console.error(`[budget] reservation for ${key} failed; attempt not sent`, err);
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, code: "BUDGET_UNAVAILABLE", message: `The budget ledger could not be written (${detail}), so no reservation was made. Nothing was sent; not retried automatically.` };
      }
      if (r.status === "RESERVED") {
        ids.set(attempt, r.row.id);
        return { ok: true };
      }
      if (r.status === "DUPLICATE") return { ok: false, code: "BUDGET_DUPLICATE", message: "This attempt already has a budget record, so it is not sent again." };
      return { ok: false, code: "BUDGET_EXHAUSTED", message: r.message };
    },
    afterAttempt: (attempt, o) => {
      const id = ids.get(attempt);
      if (!id) return;
      const req = o.kind === "REPLY" && o.requestId ? `Provider request ${o.requestId}.` : null;
      if (o.kind === "REPLY" && o.billingNote) ledger.markUnknown(id, `${o.billingNote} The reserved amount stays counted. ${req ?? ""}`.trim(), { inputTokens: o.inputTokens, outputTokens: o.outputTokens });
      else if (o.kind === "REPLY" && o.inputTokens !== null && o.outputTokens !== null) ledger.settle(id, { inputTokens: o.inputTokens, outputTokens: o.outputTokens }, req);
      else if (o.kind === "ERROR" && o.notSent) ledger.release(id, `Not sent (${o.code}).`);
      else if (o.kind === "REPLY") ledger.markUnknown(id, "Reply received but usage was not reported: actual cost unknown; the reserved amount stays counted.", { inputTokens: o.inputTokens, outputTokens: o.outputTokens });
      else if (o.kind === "TIMEOUT") ledger.markUnknown(id, "Timed out: the provider may still have processed and billed it; the reserved amount stays counted.");
      else ledger.markUnknown(id, `Error ${o.code}: the provider may have processed it; the reserved amount stays counted.`);
    },
  };
}
