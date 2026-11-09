// Storage for approvals (schema v14). Rows are immutable / append-only (DB triggers). Every method reads or writes
// through this store's own connection; `transaction` takes the write lock (BEGIN IMMEDIATE) so a re-check and the
// insert that depends on it are one atomic step. No network call is ever made while it is held.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProcurementRecord } from "../../lib/procurement.ts";
import type { RequestSnapshot } from "../../lib/quote-versions.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";
import type { Actor } from "../access/policy.ts";
import type { ApprovalSnapshot, Classification, PriorPayment } from "./evaluate.ts";

type Row = Record<string, unknown>;

export const APPROVAL_ID = /^ap_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoredApproval {
  id: string;
  requestId: string;
  seriesId: string;
  versionId: string;
  baseVersionId: string | null;
  runId: string;
  baseRunId: string | null;
  requestRevision: number;
  requestFingerprint: string;
  latestVersionNumber: number;
  reviewsDigest: string;
  statementsDigest: string;
  classificationsDigest: string;
  payeeFingerprint: string;
  rules: string;
  amountMinor: number;
  currency: string;
  snapshot: ApprovalSnapshot;
  previewDigest: string;
  confirmed: string[];
  actor: Omit<Actor, "label">;
  /** v17: approver_grants.seq of the GRANT the approver held when approving; null before v17 or when not by an approver. */
  approverGrantSeq: number | null;
  idempotencyKey: string;
  fingerprint: string;
  createdAt: string;
}

export type NewApproval = Omit<StoredApproval, "id" | "createdAt">;

export interface ApprovalEvent {
  id: string;
  approvalId: string;
  kind: "INVALIDATED" | "REVOKED";
  reasons: string[];
  note: string | null;
  actorKind: string | null;
  createdAt: string;
}

export interface LinkedPayment {
  approvalId: string;
  recordId: string;
  status: string;
  amountMinor: number;
  currency: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paypalOrderStatus: string | null;
  paypalCaptureStatus: string | null;
  sku: string;
  itemName: string;
  lastError: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface NewClassification {
  requestId: string;
  versionId: string;
  subject: string;
  textSha256: string;
  decision: Classification["decision"];
  reason: string;
  excerpt: string | null;
  excerptVersionId: string | null;
  idempotencyKey: string;
  fingerprint: string;
}

function toApproval(r: Row): StoredApproval {
  return {
    id: String(r.id),
    requestId: String(r.request_id),
    seriesId: String(r.series_id),
    versionId: String(r.version_id),
    baseVersionId: (r.base_version_id as string | null) ?? null,
    runId: String(r.run_id),
    baseRunId: (r.base_run_id as string | null) ?? null,
    requestRevision: Number(r.request_revision),
    requestFingerprint: String(r.request_fingerprint),
    latestVersionNumber: Number(r.latest_version_number),
    reviewsDigest: String(r.reviews_digest),
    statementsDigest: String(r.statements_digest),
    classificationsDigest: String(r.classifications_digest),
    payeeFingerprint: String(r.payee_fingerprint),
    rules: String(r.rules),
    amountMinor: Number(r.amount_minor),
    currency: String(r.currency),
    snapshot: JSON.parse(String(r.snapshot_json)) as ApprovalSnapshot,
    previewDigest: String(r.preview_digest),
    confirmed: JSON.parse(String(r.confirmed_json)) as string[],
    actor: { kind: String(r.actor_kind) as Actor["kind"], id: (r.actor_id as string | null) ?? null, authenticated: Number(r.actor_authenticated) === 1 },
    approverGrantSeq: r.approver_grant_seq === null || r.approver_grant_seq === undefined ? null : Number(r.approver_grant_seq),
    idempotencyKey: String(r.idempotency_key),
    fingerprint: String(r.fingerprint),
    createdAt: String(r.created_at),
  };
}

function toClassification(r: Row): Classification & { createdAt: string; idempotencyKey: string; fingerprint: string; versionId: string } {
  return {
    id: String(r.id),
    versionId: String(r.version_id),
    subject: String(r.subject),
    textSha256: String(r.text_sha256),
    decision: String(r.decision) as Classification["decision"],
    reason: String(r.reason),
    excerpt: (r.excerpt as string | null) ?? null,
    excerptVersionId: (r.excerpt_version_id as string | null) ?? null,
    idempotencyKey: String(r.idempotency_key),
    fingerprint: String(r.fingerprint),
    createdAt: String(r.created_at),
  };
}

export class ApprovalStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(filePath: string, options: OpenOptions & { now?: () => Date } = {}) {
    this.db = openDatabase(filePath, options);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  /** BEGIN IMMEDIATE … COMMIT; any throw rolls back. `fn` must not await anything. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  // ---------- reads used by the gate and the validity check ----------

  seriesVersions(seriesId: string): { id: string; versionNumber: number; contentKind: string; supplementsVersionId: string | null }[] {
    return (this.db.prepare("SELECT id, version_number, content_kind, supplements_version_id FROM quote_versions WHERE series_id = ? ORDER BY version_number").all(seriesId) as Row[]).map((r) => ({
      id: String(r.id),
      versionNumber: Number(r.version_number),
      contentKind: String(r.content_kind),
      supplementsVersionId: (r.supplements_version_id as string | null) ?? null,
    }));
  }

  versionText(versionId: string): { rawText: string; rawTextSha256: string } | null {
    const r = this.db.prepare("SELECT raw_text, raw_text_sha256 FROM quote_versions WHERE id = ?").get(versionId) as Row | undefined;
    return r ? { rawText: String(r.raw_text), rawTextSha256: String(r.raw_text_sha256) } : null;
  }

  reviewIds(runIds: string[]): string[] {
    const out: string[] = [];
    for (const id of runIds) for (const r of this.db.prepare("SELECT id FROM quote_extraction_reviews WHERE extraction_id = ?").all(id) as Row[]) out.push(String(r.id));
    return out;
  }

  /** Every stored revision after `revision` (immutable rows), not only the latest. */
  /** A REVOKE of this approver on this request at or after `sinceIso` (approver_grants, schema v15; append-only). */
  /**
   * The newest grant row of this approver on this request, read through THIS connection (inside an approval-store
   * transaction: the committed state, which no other writer can change before COMMIT). Ordered by `seq`: SQLite
   * AUTOINCREMENT — strictly increasing in commit order (writers are serialised), never reused; rows are append-only.
   */
  latestGrant(requestId: string, approverId: string): { seq: number; action: "GRANT" | "REVOKE" } | null {
    const r = this.db.prepare("SELECT seq, action FROM approver_grants WHERE request_id = ? AND approver_id = ? ORDER BY seq DESC LIMIT 1").get(requestId, approverId) as Row | undefined;
    return r ? { seq: Number(r.seq), action: String(r.action) as "GRANT" | "REVOKE" } : null;
  }

  /** A REVOKE of this approver on this request written after grant row `seq` (by sequence, never by time). */
  revokedAfter(requestId: string, approverId: string, seq: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM approver_grants WHERE request_id = ? AND approver_id = ? AND action = 'REVOKE' AND seq > ? LIMIT 1").get(requestId, approverId, seq);
  }

  revisionsAfter(requestId: string, revision: number): { revision: number; record: RequestSnapshot["record"] }[] {
    return (this.db.prepare("SELECT revision, snapshot FROM procurement_request_revisions WHERE request_id = ? AND revision > ? ORDER BY revision").all(requestId, revision) as Row[]).map((r) => ({
      revision: Number(r.revision),
      record: (JSON.parse(String(r.snapshot)) as RequestSnapshot).record,
    }));
  }

  currentRequest(requestId: string): Pick<ProcurementRecord, "revision"> | null {
    const r = this.db.prepare("SELECT revision FROM procurement_requests WHERE id = ?").get(requestId) as Row | undefined;
    return r ? { revision: Number(r.revision) } : null;
  }

  // ---------- requirement classifications ----------

  /** Latest classification per (subject, text) of one quote version. */
  classifications(versionId: string): Classification[] {
    const rows = (this.db.prepare("SELECT * FROM requirement_classifications WHERE version_id = ? ORDER BY created_at, rowid").all(versionId) as Row[]).map(toClassification);
    const latest = new Map<string, Classification>();
    for (const r of rows) latest.set(`${r.subject}\n${r.textSha256}`, { id: r.id, subject: r.subject, textSha256: r.textSha256, decision: r.decision, reason: r.reason, excerpt: r.excerpt, excerptVersionId: r.excerptVersionId });
    return [...latest.values()];
  }

  /** 7 Nov: every classification of one quote version, oldest first (append-only history; the last per subject wins). */
  classificationHistory(versionId: string) {
    return (this.db.prepare("SELECT * FROM requirement_classifications WHERE version_id = ? ORDER BY created_at, rowid").all(versionId) as Row[]).map(toClassification);
  }

  classificationByKey(key: string) {
    const r = this.db.prepare("SELECT * FROM requirement_classifications WHERE idempotency_key = ?").get(key) as Row | undefined;
    return r ? toClassification(r) : null;
  }

  insertClassification(c: NewClassification): Classification {
    const id = `rc_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO requirement_classifications (id, request_id, version_id, subject, text_sha256, decision, reason, excerpt, excerpt_version_id, idempotency_key, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.requestId, c.versionId, c.subject, c.textSha256, c.decision, c.reason, c.excerpt, c.excerptVersionId, c.idempotencyKey, c.fingerprint, this.nowIso());
    return this.classifications(c.versionId).find((x) => x.id === id) ?? { id, subject: c.subject, textSha256: c.textSha256, decision: c.decision, reason: c.reason, excerpt: c.excerpt, excerptVersionId: c.excerptVersionId };
  }

  // ---------- approvals ----------

  insertApproval(a: NewApproval): StoredApproval {
    const id = `ap_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO approvals (id, request_id, series_id, version_id, base_version_id, run_id, base_run_id, request_revision, request_fingerprint,
                                latest_version_number, reviews_digest, statements_digest, classifications_digest, payee_fingerprint, rules,
                                amount_minor, currency, snapshot_json, preview_digest, confirmed_json, actor_kind, actor_id, actor_authenticated,
                                approver_grant_seq, idempotency_key, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, a.requestId, a.seriesId, a.versionId, a.baseVersionId, a.runId, a.baseRunId, a.requestRevision, a.requestFingerprint,
        a.latestVersionNumber, a.reviewsDigest, a.statementsDigest, a.classificationsDigest, a.payeeFingerprint, a.rules,
        a.amountMinor, a.currency, JSON.stringify(a.snapshot), a.previewDigest, JSON.stringify(a.confirmed), a.actor.kind, a.actor.id, a.actor.authenticated ? 1 : 0,
        a.approverGrantSeq, a.idempotencyKey, a.fingerprint, this.nowIso(),
      );
    return this.approval(id)!;
  }

  approval(id: string): StoredApproval | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return r ? toApproval(r) : null;
  }

  approvalByKey(key: string): StoredApproval | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE idempotency_key = ?").get(key) as Row | undefined;
    return r ? toApproval(r) : null;
  }

  approvalsFor(requestId: string): StoredApproval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE request_id = ? ORDER BY created_at DESC, rowid DESC").all(requestId) as Row[]).map(toApproval);
  }

  events(approvalId: string): ApprovalEvent[] {
    return (this.db.prepare("SELECT * FROM approval_events WHERE approval_id = ? ORDER BY created_at, rowid").all(approvalId) as Row[]).map((r) => ({
      id: String(r.id),
      approvalId: String(r.approval_id),
      kind: String(r.kind) as ApprovalEvent["kind"],
      reasons: JSON.parse(String(r.reasons_json)) as string[],
      note: (r.note as string | null) ?? null,
      actorKind: (r.actor_kind as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  eventByKey(key: string): ApprovalEvent | null {
    const r = this.db.prepare("SELECT approval_id FROM approval_events WHERE idempotency_key = ?").get(key) as Row | undefined;
    return r ? (this.events(String(r.approval_id)).find((e) => e.kind === "REVOKED") ?? null) : null;
  }

  /**
   * An access-audit row (schema v15 table) through THIS connection, so that it commits or rolls back with the caller's
   * transaction (approve, revoke, payment start). Never holds secrets or quote text.
   */
  audit(e: { actorId: string | null; actorRole: string | null; action: string; objectType: string; objectId: string; outcome: "OK" | "DENIED" | "FAILED"; detail: Record<string, unknown> }): void {
    this.db
      .prepare("INSERT INTO access_audit (at, actor_id, actor_role, action, object_type, object_id, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.nowIso(), e.actorId, e.actorRole, e.action, e.objectType, e.objectId, e.outcome, JSON.stringify(e.detail).slice(0, 2000));
  }

  addEvent(approvalId: string, kind: ApprovalEvent["kind"], reasons: string[], note: string | null, actorKind: string | null, key: string | null): void {
    this.db
      .prepare("INSERT INTO approval_events (id, approval_id, kind, reasons_json, note, actor_kind, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`ape_${randomUUID()}`, approvalId, kind, JSON.stringify(reasons), note, actorKind, key, this.nowIso());
  }

  // ---------- payments ----------

  payments(approvalId: string): LinkedPayment[] {
    return this.linked("l.approval_id = ?", approvalId);
  }

  paymentsForRequest(requestId: string): PriorPayment[] {
    return this.linked("a.request_id = ?", requestId).map((p) => ({ approvalId: p.approvalId, recordId: p.recordId, status: p.status }));
  }

  private linked(where: string, param: string): LinkedPayment[] {
    return (
      this.db
        .prepare(
          `SELECT l.approval_id, l.payment_record_id, l.created_at, p.status, p.amount_minor, p.currency, p.paypal_order_id, p.paypal_capture_id,
                  p.paypal_order_status, p.paypal_capture_status, p.sku, p.item_name, p.last_error, p.paid_at
             FROM approval_payments l JOIN sandbox_payment_records p ON p.id = l.payment_record_id JOIN approvals a ON a.id = l.approval_id
            WHERE ${where} ORDER BY l.created_at, l.rowid`,
        )
        .all(param) as Row[]
    ).map((r) => ({
      approvalId: String(r.approval_id),
      recordId: String(r.payment_record_id),
      status: String(r.status),
      amountMinor: Number(r.amount_minor),
      currency: String(r.currency),
      paypalOrderId: (r.paypal_order_id as string | null) ?? null,
      paypalCaptureId: (r.paypal_capture_id as string | null) ?? null,
      paypalOrderStatus: (r.paypal_order_status as string | null) ?? null,
      paypalCaptureStatus: (r.paypal_capture_status as string | null) ?? null,
      sku: String(r.sku),
      itemName: String(r.item_name),
      lastError: (r.last_error as string | null) ?? null,
      paidAt: (r.paid_at as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  /**
   * A NEW Sandbox payment record for an approval, with amount / currency copied from the approval row, and its link —
   * in the caller's transaction (same columns and first event as PaymentStore.insert).
   */
  insertPayment(approval: StoredApproval, recordId: string, createRequestId: string, itemName: string, sku = "TP-APPROVAL"): void {
    const at = this.nowIso();
    this.db
      .prepare(
        `INSERT INTO sandbox_payment_records (id, sku, item_name, amount_minor, currency, status, create_request_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'NEW', ?, ?, ?)`,
      )
      .run(recordId, sku, itemName, approval.amountMinor, approval.currency, createRequestId, at, at);
    this.db
      .prepare("INSERT INTO sandbox_payment_events (record_id, at, type, detail) VALUES (?, ?, 'RECORD_CREATED', ?)")
      .run(recordId, at, JSON.stringify({ amountMinor: approval.amountMinor, currency: approval.currency, approvalId: approval.id }));
    this.db.prepare("INSERT INTO approval_payments (approval_id, payment_record_id, created_at) VALUES (?, ?, ?)").run(approval.id, recordId, at);
  }
}
