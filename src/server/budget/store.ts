// Overall API budget ledger (schema v9) on the shared local SQLite file.
//
// reserve() runs in ONE `BEGIN IMMEDIATE` transaction: SQLite's write lock serialises it across
// connections and processes, so two requests racing for the last part of the budget cannot both pass.
// It (1) refuses a request key that was already used (no second reservation or call for the same
// attempt), (2) marks stale RESERVED rows UNKNOWN (kept as spent; never released, never re-sent),
// (3) sums every LIVE attempt of every request and version — today (Singapore day) and in total —
// and (4) inserts the reservation only if calls + 1 and spend + this upper bound stay within the limits.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { budgetDay, type BudgetStatus, type BudgetTotals, type LedgerState } from "../../lib/budget.ts";
import { EXTRACTION_LIMITS } from "../../lib/extraction.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";
import { boundMicros, costMicros, type BudgetConfig, type BudgetConfigResult } from "./config.ts";

type Row = Record<string, unknown>;

/** A RESERVED row older than this cannot still be waiting for its reply (one attempt's timeout + margin). */
export const RESERVATION_STALE_MS = EXTRACTION_LIMITS.timeoutMs + 30_000;

export type LedgerPurpose = "QUOTE_EXTRACTION" | "COPILOT_ANSWER";

export interface LedgerRow {
  id: string;
  requestKey: string;
  /** v18: what the call was for. Both purposes count against the same limits. */
  purpose: LedgerPurpose;
  extractionId: string | null;
  /** v18: COPILOT_ANSWER rows name the procurement request that was explained (never a run); null otherwise. */
  copilotRequestId: string | null;
  attempt: number;
  provider: string;
  model: string;
  currency: string;
  reservedMicros: number;
  inputTokensBound: number;
  outputTokensBound: number;
  state: LedgerState;
  inputTokens: number | null;
  outputTokens: number | null;
  settledMicros: number | null;
  outcomeNote: string | null;
  budgetDay: string;
  reservedAt: string;
  closedAt: string | null;
}

export interface NewReservation {
  requestKey: string;
  /**
   * Optional exclusive prefix (Copilot, 2 Nov, later): inside the same write transaction, ANY existing row whose key starts with
   * it is a DUPLICATE (returned, nothing inserted). The Copilot puts account + record + click key in the prefix and the
   * question / basis binding after it, so a reused click key never gets a second reservation, across processes and
   * restarts, and the caller can tell "same request" from "same key, other request".
   */
  uniquePrefix?: string;
  /** Default QUOTE_EXTRACTION (unchanged behaviour of every existing caller). */
  purpose?: LedgerPurpose;
  extractionId: string | null;
  /** Required for COPILOT_ANSWER (the database refuses the row otherwise); must be null for QUOTE_EXTRACTION. */
  copilotRequestId?: string | null;
  attempt: number;
  inputTokensBound: number;
  outputTokensBound: number;
}

export type ReserveOutcome =
  | { status: "RESERVED"; row: LedgerRow }
  | { status: "DUPLICATE"; row: LedgerRow }
  | { status: "REFUSED"; code: "DAILY_CALLS" | "TOTAL_CALLS" | "DAILY_AMOUNT" | "TOTAL_AMOUNT" | "CURRENCY_MISMATCH"; message: string };

const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRow(r: Row): LedgerRow {
  return {
    id: String(r.id),
    requestKey: String(r.request_key),
    purpose: String(r.purpose) as LedgerPurpose,
    extractionId: r.extraction_id === null ? null : String(r.extraction_id),
    copilotRequestId: r.copilot_request_id === null || r.copilot_request_id === undefined ? null : String(r.copilot_request_id),
    attempt: Number(r.attempt),
    provider: String(r.provider),
    model: String(r.model),
    currency: String(r.currency),
    reservedMicros: Number(r.reserved_micros),
    inputTokensBound: Number(r.input_tokens_bound),
    outputTokensBound: Number(r.output_tokens_bound),
    state: String(r.state) as LedgerState,
    inputTokens: int(r.input_tokens),
    outputTokens: int(r.output_tokens),
    settledMicros: int(r.settled_micros),
    outcomeNote: r.outcome_note === null ? null : String(r.outcome_note),
    budgetDay: String(r.budget_day),
    reservedAt: String(r.reserved_at),
    closedAt: r.closed_at === null ? null : String(r.closed_at),
  };
}

// What a row counts as: settled estimate, or its full reservation while in flight / unknown; released = 0.
const SUMS = `
  SELECT currency,
         count(*) FILTER (WHERE state <> 'RELEASED') AS calls,
         coalesce(sum(CASE WHEN state = 'SETTLED' THEN settled_micros ELSE 0 END), 0) AS settled,
         coalesce(sum(CASE WHEN state IN ('RESERVED', 'UNKNOWN') THEN reserved_micros ELSE 0 END), 0) AS pending,
         count(*) FILTER (WHERE state = 'UNKNOWN') AS unknown
    FROM ai_budget_ledger`;

const EMPTY: BudgetTotals = { calls: 0, settledMicros: 0, pendingMicros: 0, unknownCount: 0 };
const totalsOf = (r: Row | undefined): BudgetTotals =>
  r ? { calls: Number(r.calls), settledMicros: Number(r.settled), pendingMicros: Number(r.pending), unknownCount: Number(r.unknown) } : { ...EMPTY };
const used = (t: BudgetTotals) => t.settledMicros + t.pendingMicros;

export class BudgetStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(filePath: string, options: OpenOptions & { now?: () => Date } = {}) {
    this.db = openDatabase(filePath, options);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** RESERVED rows past the stale limit → UNKNOWN (still counted at their reserved amount). Returns how many. */
  private recoverStale(): number {
    const before = new Date(this.now().getTime() - RESERVATION_STALE_MS).toISOString();
    const r = this.db
      .prepare(
        `UPDATE ai_budget_ledger SET state = 'UNKNOWN', closed_at = ?,
                outcome_note = 'No outcome was recorded (the server stopped or the call never returned). Kept as spent; not retried.'
          WHERE state = 'RESERVED' AND reserved_at < ?`,
      )
      .run(this.now().toISOString(), before);
    return Number(r.changes);
  }

  private sums(currency: string, day: string | null): BudgetTotals {
    const r = (day === null ? this.db.prepare(`${SUMS} WHERE currency = ? GROUP BY currency`).get(currency) : this.db.prepare(`${SUMS} WHERE currency = ? AND budget_day = ? GROUP BY currency`).get(currency, day)) as Row | undefined;
    return totalsOf(r);
  }

  /** Atomic check-and-reserve of one attempt's upper bound. Only RESERVED may lead to a model call. */
  reserve(config: BudgetConfig, input: NewReservation): ReserveOutcome {
    const bound = boundMicros(config.prices, input.inputTokensBound, input.outputTokensBound);
    return this.transaction((): ReserveOutcome => {
      const existing = this.db.prepare("SELECT * FROM ai_budget_ledger WHERE request_key = ?").get(input.requestKey) as Row | undefined;
      if (existing) return { status: "DUPLICATE", row: toRow(existing) };
      if (input.uniquePrefix) {
        const same = this.db.prepare("SELECT * FROM ai_budget_ledger WHERE substr(request_key, 1, ?) = ? ORDER BY reserved_at LIMIT 1").get(input.uniquePrefix.length, input.uniquePrefix) as Row | undefined;
        if (same) return { status: "DUPLICATE", row: toRow(same) };
      }
      this.recoverStale();
      const other = this.db.prepare("SELECT DISTINCT currency FROM ai_budget_ledger WHERE currency <> ?").all(config.currency) as Row[];
      if (other.length > 0) {
        return { status: "REFUSED", code: "CURRENCY_MISMATCH", message: `Spend is already recorded in ${other.map((o) => o.currency).join(", ")}, but the budget is in ${config.currency}. Nothing is converted, so no real call is made.` };
      }
      const now = this.now();
      const day = budgetDay(now);
      const today = this.sums(config.currency, day);
      const total = this.sums(config.currency, null);
      const l = config.limits;
      if (today.calls + 1 > l.dailyCalls) return { status: "REFUSED", code: "DAILY_CALLS", message: `Daily limit of ${l.dailyCalls} model calls reached (Singapore day ${day}). Nothing was sent.` };
      if (total.calls + 1 > l.totalCalls) return { status: "REFUSED", code: "TOTAL_CALLS", message: `Overall limit of ${l.totalCalls} model calls reached. Nothing was sent.` };
      if (used(today) + bound > l.dailyMicros) return { status: "REFUSED", code: "DAILY_AMOUNT", message: `Today's remaining budget does not cover this call's upper-bound cost. Nothing was sent.` };
      if (used(total) + bound > l.totalMicros) return { status: "REFUSED", code: "TOTAL_AMOUNT", message: `The remaining overall budget does not cover this call's upper-bound cost. Nothing was sent.` };
      const id = `abl_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO ai_budget_ledger
             (id, request_key, purpose, extraction_id, copilot_request_id, attempt, provider, model, currency, reserved_micros,
              input_tokens_bound, output_tokens_bound, price_basis, state, budget_day, reserved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)`,
        )
        .run(
          id,
          input.requestKey,
          input.purpose ?? "QUOTE_EXTRACTION",
          input.extractionId,
          input.copilotRequestId ?? null,
          input.attempt,
          config.provider,
          config.model,
          config.currency,
          bound,
          input.inputTokensBound,
          input.outputTokensBound,
          JSON.stringify(config.prices),
          day,
          now.toISOString(),
        );
      return { status: "RESERVED", row: this.get(id)! };
    });
  }

  get(id: string): LedgerRow | null {
    const r = this.db.prepare("SELECT * FROM ai_budget_ledger WHERE id = ?").get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** Copilot rows of one request (for tests and the acceptance runner; never shown to the browser). */
  listForCopilotRequest(requestId: string): LedgerRow[] {
    return (this.db.prepare("SELECT * FROM ai_budget_ledger WHERE copilot_request_id = ? ORDER BY reserved_at, id").all(requestId) as Row[]).map(toRow);
  }

  /** The first row whose request key starts with `prefix` (read-only). */
  firstWithPrefix(prefix: string): LedgerRow | null {
    const r = this.db.prepare("SELECT * FROM ai_budget_ledger WHERE substr(request_key, 1, ?) = ? ORDER BY reserved_at LIMIT 1").get(prefix.length, prefix) as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** The row of one request key, if any (read-only). */
  byRequestKey(requestKey: string): LedgerRow | null {
    const r = this.db.prepare("SELECT * FROM ai_budget_ledger WHERE request_key = ?").get(requestKey) as Row | undefined;
    return r ? toRow(r) : null;
  }

  listForExtraction(extractionId: string): LedgerRow[] {
    return (this.db.prepare("SELECT * FROM ai_budget_ledger WHERE extraction_id = ? ORDER BY attempt").all(extractionId) as Row[]).map(toRow);
  }

  /**
   * Usage reported → SETTLED with the estimate at the prices used for the reservation. Only from
   * RESERVED, so a second settlement (or one after the row was marked UNKNOWN) changes nothing.
   */
  settle(id: string, usage: { inputTokens: number; outputTokens: number }, note: string | null = null): boolean {
    const row = this.get(id);
    if (!row) return false;
    const prices = JSON.parse(String((this.db.prepare("SELECT price_basis FROM ai_budget_ledger WHERE id = ?").get(id) as Row).price_basis));
    const estimate = costMicros(prices, usage.inputTokens, usage.outputTokens);
    const over = estimate > row.reservedMicros ? "Reported usage exceeded the reserved upper bound; the estimate from usage is recorded." : null;
    const fullNote = [note, over].filter(Boolean).join(" ").slice(0, 500) || null;
    const r = this.db
      .prepare("UPDATE ai_budget_ledger SET state = 'SETTLED', input_tokens = ?, output_tokens = ?, settled_micros = ?, outcome_note = ?, closed_at = ? WHERE id = ? AND state = 'RESERVED'")
      .run(usage.inputTokens, usage.outputTokens, estimate, fullNote, this.now().toISOString(), id);
    return Number(r.changes) === 1;
  }

  /** May have been sent, outcome or usage unknown → UNKNOWN; the full reservation stays counted. */
  markUnknown(id: string, note: string, usage: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null }): boolean {
    const r = this.db
      .prepare("UPDATE ai_budget_ledger SET state = 'UNKNOWN', input_tokens = ?, output_tokens = ?, outcome_note = ?, closed_at = ? WHERE id = ? AND state = 'RESERVED'")
      .run(usage.inputTokens, usage.outputTokens, note.slice(0, 500), this.now().toISOString(), id);
    return Number(r.changes) === 1;
  }

  /** Only when the request was definitely not sent (e.g. refused locally before any connection). */
  release(id: string, note: string): boolean {
    const r = this.db.prepare("UPDATE ai_budget_ledger SET state = 'RELEASED', outcome_note = ?, closed_at = ? WHERE id = ? AND state = 'RESERVED'").run(note.slice(0, 500), this.now().toISOString(), id);
    return Number(r.changes) === 1;
  }

  /** Read for the page. Also closes stale reservations as UNKNOWN (never releases them). */
  status(config: BudgetConfigResult): BudgetStatus {
    const day = budgetDay(this.now());
    this.transaction(() => this.recoverStale());
    const currencies = (this.db.prepare("SELECT DISTINCT currency FROM ai_budget_ledger ORDER BY currency").all() as Row[]).map((r) => String(r.currency));
    if (!config.ok) {
      return { state: "NOT_CONFIGURED", missing: config.missing, problems: config.problems, recorded: currencies.map((c) => ({ currency: c, today: this.sums(c, day), total: this.sums(c, null) })), day };
    }
    const c = config.config;
    const today = this.sums(c.currency, day);
    const total = this.sums(c.currency, null);
    return {
      state: "CONFIGURED",
      currency: c.currency,
      provider: c.provider,
      model: c.model,
      limits: c.limits,
      today,
      total,
      remainingTodayMicros: Math.max(0, c.limits.dailyMicros - used(today)),
      remainingTotalMicros: Math.max(0, c.limits.totalMicros - used(total)),
      remainingTodayCalls: Math.max(0, c.limits.dailyCalls - today.calls),
      remainingTotalCalls: Math.max(0, c.limits.totalCalls - total.calls),
      day,
      otherCurrencies: currencies.filter((x) => x !== c.currency),
    };
  }
}
