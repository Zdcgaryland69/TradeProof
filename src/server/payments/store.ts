// Durable payment-record store on Node's built-in SQLite (node:sqlite, Node >= 22.13).
// Every state change is a conditional UPDATE (compare-and-set) so that concurrent requests —
// even from separate processes sharing the file — cannot both start the same PayPal operation.

import type { DatabaseSync } from "node:sqlite";
import { openDatabase, type OpenOptions } from "../db/database.ts";
import type { PaymentRecord, RecordStatus } from "./types.ts";

// Schema and migrations: ../db/database.ts (one local DB file shared with the procurement tables).

/** Columns a transition may write. Keys are whitelisted, so SQL is never built from input. */
const PATCH_COLUMNS = {
  status: "status",
  captureRequestId: "capture_request_id",
  createStartedAt: "create_started_at",
  captureStartedAt: "capture_started_at",
  captureStartedPayPalAt: "capture_started_paypal_at",
  paypalOrderId: "paypal_order_id",
  paypalCaptureId: "paypal_capture_id",
  paypalOrderStatus: "paypal_order_status",
  paypalCaptureStatus: "paypal_capture_status",
  leaseUntil: "lease_until",
  lastError: "last_error",
  reviewReasons: "review_reasons",
  paidAt: "paid_at",
} as const;

export type RecordPatch = Partial<{
  status: RecordStatus;
  captureRequestId: string;
  createStartedAt: number;
  captureStartedAt: number;
  captureStartedPayPalAt: number;
  paypalOrderId: string;
  paypalCaptureId: string;
  paypalOrderStatus: string | null;
  paypalCaptureStatus: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  reviewReasons: string[];
  paidAt: string;
}>;

export interface TransitionGuard {
  /** Statuses the record must currently be in. */
  from: readonly RecordStatus[];
  /** Additionally allow this status when its lease has expired (crash / abandoned request recovery). */
  staleLeaseStatus?: RecordStatus;
  nowMs?: number;
}

export interface NewRecord {
  id: string;
  sku: string;
  itemName: string;
  amountMinor: number;
  currency: string;
  createRequestId: string;
}

type Row = Record<string, unknown>;

function rowToRecord(row: Row): PaymentRecord {
  return {
    id: String(row.id),
    sku: String(row.sku),
    itemName: String(row.item_name),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    status: row.status as RecordStatus,
    createRequestId: String(row.create_request_id),
    captureRequestId: (row.capture_request_id as string | null) ?? null,
    createStartedAt: row.create_started_at === null || row.create_started_at === undefined ? null : Number(row.create_started_at),
    captureStartedAt: row.capture_started_at === null || row.capture_started_at === undefined ? null : Number(row.capture_started_at),
    captureStartedPayPalAt:
      row.capture_started_paypal_at === null || row.capture_started_paypal_at === undefined ? null : Number(row.capture_started_paypal_at),
    paypalOrderId: (row.paypal_order_id as string | null) ?? null,
    paypalCaptureId: (row.paypal_capture_id as string | null) ?? null,
    paypalOrderStatus: (row.paypal_order_status as string | null) ?? null,
    paypalCaptureStatus: (row.paypal_capture_status as string | null) ?? null,
    leaseUntil: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
    lastError: (row.last_error as string | null) ?? null,
    reviewReasons: JSON.parse(String(row.review_reasons ?? "[]")) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    paidAt: (row.paid_at as string | null) ?? null,
  };
}

export class PaymentStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options?: OpenOptions) {
    this.db = openDatabase(filePath, options);
  }

  close(): void {
    this.db.close();
  }

  insert(rec: NewRecord, nowIso: string): PaymentRecord {
    this.db
      .prepare(
        `INSERT INTO sandbox_payment_records
           (id, sku, item_name, amount_minor, currency, status, create_request_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'NEW', ?, ?, ?)`,
      )
      .run(rec.id, rec.sku, rec.itemName, rec.amountMinor, rec.currency, rec.createRequestId, nowIso, nowIso);
    this.logEvent(rec.id, "RECORD_CREATED", { amountMinor: rec.amountMinor, currency: rec.currency }, nowIso);
    return this.get(rec.id)!;
  }

  get(id: string): PaymentRecord | null {
    const row = this.db.prepare("SELECT * FROM sandbox_payment_records WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(limit = 20): PaymentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sandbox_payment_records ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(rowToRecord);
  }

  /**
   * Atomically apply `patch` only if the record is in one of `guard.from` (or in
   * `guard.staleLeaseStatus` with an expired lease). Returns true when this caller won.
   */
  transition(id: string, guard: TransitionGuard, patch: RecordPatch, nowIso: string): boolean {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [nowIso];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof RecordPatch, string][]) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (key === "captureRequestId" || key === "createStartedAt" || key === "captureStartedAt" || key === "captureStartedPayPalAt") {
        // Set once: a retried operation must reuse its request id and keep its original start time.
        sets.push(`${column} = COALESCE(${column}, ?)`);
      } else {
        sets.push(`${column} = ?`);
      }
      values.push(key === "reviewReasons" ? JSON.stringify(value) : ((value ?? null) as string | number | null));
    }
    const placeholders = guard.from.map(() => "?").join(", ") || "NULL";
    let where = `id = ? AND (status IN (${placeholders})`;
    const whereValues: (string | number)[] = [id, ...guard.from];
    if (guard.staleLeaseStatus) {
      where += " OR (status = ? AND (lease_until IS NULL OR lease_until < ?))";
      whereValues.push(guard.staleLeaseStatus, guard.nowMs ?? Date.now());
    }
    where += ")";
    const result = this.db
      .prepare(`UPDATE sandbox_payment_records SET ${sets.join(", ")} WHERE ${where}`)
      .run(...values, ...whereValues);
    return Number(result.changes) === 1;
  }

  /**
   * `transition` preceded, inside ONE `BEGIN IMMEDIATE` transaction on this connection, by `check` (read-only; it may
   * read through other connections — while this one holds the write lock no other writer can commit, so what it
   * reads is current until COMMIT). REFUSED = the check failed and nothing was written. The PayPal call that follows
   * a WON transition happens after COMMIT, never inside the lock.
   */
  transitionChecked(id: string, guard: TransitionGuard, patch: RecordPatch, nowIso: string, check: () => boolean): "WON" | "LOST" | "REFUSED" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!check()) {
        this.db.exec("ROLLBACK");
        return "REFUSED";
      }
      const won = this.transition(id, guard, patch, nowIso);
      this.db.exec("COMMIT");
      return won ? "WON" : "LOST";
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  logEvent(recordId: string, type: string, detail: Record<string, unknown>, nowIso: string): void {
    this.db
      .prepare("INSERT INTO sandbox_payment_events (record_id, at, type, detail) VALUES (?, ?, ?, ?)")
      .run(recordId, nowIso, type, JSON.stringify(detail));
  }

  events(recordId: string): { at: string; type: string; detail: Record<string, unknown> }[] {
    const rows = this.db
      .prepare("SELECT at, type, detail FROM sandbox_payment_events WHERE record_id = ? ORDER BY seq")
      .all(recordId) as Row[];
    return rows.map((r) => ({ at: String(r.at), type: String(r.type), detail: JSON.parse(String(r.detail ?? "{}")) }));
  }
}
