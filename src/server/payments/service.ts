// Payment state machine for the Sandbox spike:
//   create local record → create PayPal order → buyer approves (browser) → capture → GET + verify → PAID
//
// Rules enforced here (not in the UI):
// - amount / currency come only from the local record (fixed catalog item);
// - a PayPal order is only ever created for, and captured through, its own local record;
// - each logical operation has ONE PayPal-Request-Id, persisted before the call and reused on retry
//   (create: create_request_id, capture: capture_request_id — always different);
// - concurrent callers race on a conditional UPDATE; only the winner calls PayPal;
// - an unknown outcome (timeout / 5xx / network) is stored as such and resolved by querying PayPal,
//   never by creating a new order or assuming "unpaid";
// - PAID only after `verifyCapturedOrder` passes on a fresh GET of the order;
// - an automatic retry reuses a PayPal-Request-Id only inside PayPal's documented retention window
//   ("The server stores keys for 6 hours", Orders v2 spec); older unknown outcomes go to manual review.

import { randomUUID } from "node:crypto";
import { formatMinorUnits } from "./money.ts";
import { SANDBOX_TEST_ITEM, type TestItem } from "./catalog.ts";
import type { PaymentStore, RecordPatch } from "./store.ts";
import { GatewayError, type GatewayOrder, type PayPalGateway, type PaymentRecord, type RecordStatus } from "./types.ts";
import { checkBeforeCapture, expectationFor, verifyCapturedOrder } from "./verify.ts";

export type ResultCode =
  | "RECORD_CREATED"
  | "ORDER_READY"
  | "PAID"
  | "ALREADY_PAID"
  | "NOT_FOUND"
  | "NOT_CONFIGURED"
  | "ORDER_MISMATCH"
  | "NOT_READY"
  | "NOT_APPROVED"
  | "IN_PROGRESS"
  | "CREATE_UNKNOWN"
  | "CAPTURE_UNKNOWN"
  | "CAPTURE_PENDING"
  | "LOOKUP_FAILED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "INVALID_STATE"
  | "APPROVAL_INVALID";

export interface ServiceResult {
  ok: boolean;
  code: ResultCode;
  message: string;
  record: PaymentRecord | null;
  orderId?: string;
  problems?: string[];
}

/**
 * Optional precondition for a payment that belongs to an in-app approval (29 Oct). Read-only; returns null when the
 * operation may go ahead, else a reason code. It is evaluated inside the same write transaction as the state change
 * that commits TradeProof to a PayPal create / capture call, so a basis change either commits before (and stops it)
 * or after (and does not stop a call already decided). Reads of PayPal are never guarded.
 */
export type PaymentGuard = () => string | null;
export interface GuardOptions {
  guard?: PaymentGuard;
  /**
   * Approval payments (30 Oct): once a capture request may have been sent (CAPTURING with an expired lease, or
   * CAPTURE_UNKNOWN), capture and reconcile only READ PayPal — a capture PayPal shows is recorded, none found keeps
   * CAPTURE_UNKNOWN; the capture request is never sent again, not even with the same PayPal-Request-Id. Reconcile of
   * an unknown order creation does not repeat the create request either (only an explicit "create order" does).
   */
  noResendAfterUnknown?: boolean;
}

export interface PaymentServiceDeps {
  store: PaymentStore;
  /** null when PayPal is not configured — every PayPal operation then returns NOT_CONFIGURED. */
  gateway: PayPalGateway | null;
  /** Expected payee (Sandbox Business account merchant id). */
  payeeMerchantId: string | null;
  now?: () => Date;
  newId?: () => string;
  leaseMs?: number;
  item?: TestItem;
  /** Override for tests; defaults to AUTO_RETRY_WINDOW_MS. */
  retryWindowMs?: number;
  /**
   * 9 Nov: true when `gateway` is the simulated MOCK PayPal (database copies only). Result messages then say so and
   * never claim a PayPal check: the same state machine runs, but no PayPal request is made and no money moves.
   */
  simulated?: boolean;
}

/** Result messages that name PayPal, as worded for the simulated MOCK gateway (9 Nov). */
const MOCK_MESSAGES: Record<string, string> = {
  "Payment captured and verified against PayPal.":
    "MOCK capture recorded and checked against the simulated MOCK PayPal (order, capture, amount, currency, payee). No PayPal request was made and no money moved.",
  "PayPal order created.": "MOCK order created on the simulated MOCK PayPal. No PayPal request was made.",
  "Existing PayPal order reused.": "Existing MOCK order reused. No PayPal request was made.",
  "Re-verified against PayPal: still paid.": "Re-checked against the simulated MOCK PayPal: still paid (MOCK). No PayPal request was made.",
};
/** Any other message in MOCK mode is prefixed, so no MOCK result reads as a PayPal result. */
export function mockMessage(message: string): string {
  return MOCK_MESSAGES[message] ?? `MOCK (simulated PayPal, no PayPal request): ${message}`;
}

/** PayPal-Request-Id retention documented for Orders v2 create/capture (paypal-rest-api-specifications). */
export const PAYPAL_IDEMPOTENCY_RETENTION_MS = 6 * 60 * 60 * 1000;
/** Automatic retries with an existing request id only within this window (1 h safety margin). */
export const AUTO_RETRY_WINDOW_MS = PAYPAL_IDEMPOTENCY_RETENTION_MS - 60 * 60 * 1000;
/** A start time more than this far in the future means the clock went back: not provably in the window. */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

const AFTER_ORDER_STATUSES: readonly RecordStatus[] = ["ORDER_CREATED", "CAPTURING", "CAPTURE_UNKNOWN", "CAPTURE_PENDING"];

function errorSummary(err: unknown): string {
  if (err instanceof GatewayError) {
    const parts = [err.message, err.httpStatus && `HTTP ${err.httpStatus}`, err.issue, err.debugId && `debug_id ${err.debugId}`];
    return parts.filter(Boolean).join(" · ");
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

function isUncertain(err: unknown): boolean {
  return !(err instanceof GatewayError) || err.certainty === "uncertain";
}

export class PaymentService {
  private readonly store: PaymentStore;
  private readonly gateway: PayPalGateway | null;
  private readonly payeeMerchantId: string | null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly leaseMs: number;
  private readonly item: TestItem;
  private readonly retryWindowMs: number;
  private readonly simulated: boolean;

  constructor(deps: PaymentServiceDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.payeeMerchantId = deps.payeeMerchantId;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.leaseMs = deps.leaseMs ?? 60_000;
    this.item = deps.item ?? SANDBOX_TEST_ITEM;
    this.retryWindowMs = deps.retryWindowMs ?? AUTO_RETRY_WINDOW_MS;
    this.simulated = deps.simulated ?? false;
  }

  /**
   * True only if the elapsed time since `startedAt` is provably inside the retry window on one clock.
   * Missing / invalid times, or a start time in the future (clock set back), are NOT provable.
   */
  private provablyWithinWindow(startedAt: number | null | undefined, now: number | null | undefined): boolean {
    if (typeof startedAt !== "number" || typeof now !== "number" || !Number.isFinite(startedAt) || !Number.isFinite(now)) return false;
    const elapsed = now - startedAt;
    return elapsed >= -CLOCK_SKEW_TOLERANCE_MS && elapsed <= this.retryWindowMs;
  }

  /** Local wall clock (the only reference for create retries: no PayPal response exists yet). */
  private withinRetryWindow(startedAt: number | null): boolean {
    return this.provablyWithinWindow(startedAt, this.now().getTime());
  }

  get configured(): boolean {
    return this.gateway !== null && !!this.payeeMerchantId;
  }

  getRecord(id: string): PaymentRecord | null {
    return this.store.get(id);
  }

  listRecords(limit = 20): PaymentRecord[] {
    return this.store.list(limit);
  }

  events(id: string) {
    return this.store.events(id);
  }

  // ---------- helpers ----------

  private iso(): string {
    return this.now().toISOString();
  }

  private result(ok: boolean, code: ResultCode, message: string, id: string | null, extra: Partial<ServiceResult> = {}): ServiceResult {
    return { ok, code, message: this.simulated ? mockMessage(message) : message, record: id ? this.store.get(id) : null, ...extra };
  }

  private move(id: string, from: readonly RecordStatus[], patch: RecordPatch, event: string, detail: Record<string, unknown> = {}): boolean {
    const nowIso = this.iso();
    const won = this.store.transition(id, { from, nowMs: this.now().getTime() }, patch, nowIso);
    if (won) this.store.logEvent(id, event, { ...detail, to: patch.status }, nowIso);
    return won;
  }

  private notConfigured(id: string | null): ServiceResult {
    return this.result(false, "NOT_CONFIGURED", "PayPal Sandbox is not configured (未配置). No payment can be made.", id);
  }

  // ---------- 1. local test record ----------

  /** Creates a local test record. Amount and currency come from the fixed catalog item only. */
  createTestRecord(): ServiceResult {
    const id = `tp_${this.newId()}`;
    this.store.insert(
      {
        id,
        sku: this.item.sku,
        itemName: this.item.name,
        amountMinor: this.item.amountMinor,
        currency: this.item.currency,
        createRequestId: this.newId(),
      },
      this.iso(),
    );
    return this.result(true, "RECORD_CREATED", "Local test record created.", id);
  }

  // ---------- 2. create PayPal order ----------

  async createPayPalOrder(id: string, opts: GuardOptions = {}): Promise<ServiceResult> {
    const rec = this.store.get(id);
    if (!rec) return this.result(false, "NOT_FOUND", "Unknown local record.", null);
    if (rec.status === "PAID") return this.result(false, "ALREADY_PAID", "Record is already paid.", id);
    if (rec.paypalOrderId) {
      if (rec.status === "ORDER_CREATED") {
        // One PayPal order per record: hand back the existing one instead of creating another.
        return this.result(true, "ORDER_READY", "Existing PayPal order reused.", id, { orderId: rec.paypalOrderId });
      }
      return this.result(false, "INVALID_STATE", `Record is ${rec.status}; no new approval possible.`, id);
    }
    if (rec.status !== "NEW" && rec.status !== "ORDER_CREATING") {
      return this.result(false, "INVALID_STATE", `Record is ${rec.status}.`, id);
    }
    if (!this.gateway || !this.configured) return this.notConfigured(id);

    const nowMs = this.now().getTime();
    if (rec.status === "ORDER_CREATING" && (rec.leaseUntil ?? 0) <= nowMs && !this.withinRetryWindow(rec.createStartedAt)) {
      // A retry now might not be deduplicated by PayPal. No order id is known locally, and an unapproved
      // order cannot be paid, so stop here and leave it to a person to check the PayPal dashboard.
      const reason = "Order creation outcome unknown and older than PayPal's PayPal-Request-Id retention window; not retried automatically. Check the Sandbox dashboard manually.";
      this.move(id, ["ORDER_CREATING"], { status: "FAILED", leaseUntil: null, lastError: reason, reviewReasons: [reason] }, "CREATE_RETRY_WINDOW_EXPIRED");
      return this.result(false, "FAILED", reason, id);
    }
    const createGuard = { from: ["NEW"] as RecordStatus[], staleLeaseStatus: "ORDER_CREATING" as const, nowMs };
    const createPatch = { status: "ORDER_CREATING" as const, leaseUntil: nowMs + this.leaseMs, createStartedAt: nowMs };
    let problem: string | null = null;
    const outcome = opts.guard
      ? this.store.transitionChecked(id, createGuard, createPatch, this.iso(), () => (problem = opts.guard!()) === null)
      : this.store.transition(id, createGuard, createPatch, this.iso()) ? "WON" : "LOST";
    if (outcome === "REFUSED") {
      // No create request is sent (nor re-sent with the same id): the record keeps its real state.
      this.store.logEvent(id, "CREATE_REFUSED_APPROVAL_INVALID", { reason: problem }, this.iso());
      return this.result(false, "APPROVAL_INVALID", `The approval behind this payment is no longer valid (${problem}); no PayPal order request was sent.`, id);
    }
    if (outcome !== "WON") return this.result(false, "IN_PROGRESS", "Order creation already in progress.", id);
    this.store.logEvent(id, "CREATE_ATTEMPT", { paypalRequestId: rec.createRequestId }, this.iso());

    let order: GatewayOrder;
    try {
      order = await this.gateway.createOrder(
        {
          localId: rec.id,
          description: rec.itemName,
          amount: { currencyCode: rec.currency, value: formatMinorUnits(rec.amountMinor, rec.currency) },
        },
        rec.createRequestId, // same id on every retry of this logical create
      );
    } catch (err) {
      if (isUncertain(err)) {
        // Outcome unknown: release the lease so a retry (same PayPal-Request-Id) can run right away.
        this.move(id, ["ORDER_CREATING"], { leaseUntil: 0, lastError: errorSummary(err) }, "CREATE_UNKNOWN", { error: errorSummary(err) });
        return this.result(false, "CREATE_UNKNOWN", "Order creation outcome unknown; retrying is safe (same PayPal-Request-Id).", id);
      }
      this.move(id, ["ORDER_CREATING"], { status: "FAILED", leaseUntil: null, lastError: errorSummary(err) }, "CREATE_REJECTED", { error: errorSummary(err) });
      return this.result(false, "FAILED", "PayPal rejected order creation.", id);
    }

    if (!order.id) {
      this.move(id, ["ORDER_CREATING"], { leaseUntil: 0, lastError: "create response without order id" }, "CREATE_UNKNOWN");
      return this.result(false, "CREATE_UNKNOWN", "PayPal response had no order id; retry is safe.", id);
    }
    const stored = this.move(
      id,
      ["ORDER_CREATING"],
      { status: "ORDER_CREATED", paypalOrderId: order.id, paypalOrderStatus: order.status ?? null, leaseUntil: null, lastError: null },
      "ORDER_CREATED",
      { paypalOrderId: order.id, paypalOrderStatus: order.status },
    );
    const after = this.store.get(id)!;
    if (!stored && after.paypalOrderId !== order.id) {
      return this.result(false, "INVALID_STATE", "Record changed during order creation.", id);
    }
    return this.result(true, "ORDER_READY", "PayPal order created.", id, { orderId: order.id });
  }

  // ---------- 3. capture ----------

  /**
   * Capture the PayPal order linked to local record `id`. `clientOrderId` (what the browser saw)
   * is only cross-checked; the order id actually used always comes from the database.
   */
  async capture(id: string, clientOrderId?: string, opts: GuardOptions = {}): Promise<ServiceResult> {
    const rec = this.store.get(id);
    if (!rec) return this.result(false, "NOT_FOUND", "Unknown local record.", null);
    if (clientOrderId !== undefined && clientOrderId !== rec.paypalOrderId) {
      this.store.logEvent(id, "CAPTURE_REJECTED_ORDER_MISMATCH", {}, this.iso());
      return this.result(false, "ORDER_MISMATCH", "That PayPal order is not linked to this record; nothing captured.", id);
    }
    switch (rec.status) {
      case "PAID":
        return this.result(true, "ALREADY_PAID", "Already paid; no second capture.", id);
      case "NEW":
      case "ORDER_CREATING":
        return this.result(false, "NOT_READY", "No PayPal order for this record yet.", id);
      case "NEEDS_REVIEW":
      case "FAILED":
        return this.result(false, "INVALID_STATE", `Record is ${rec.status}; capture refused.`, id);
      case "CAPTURING":
        if ((rec.leaseUntil ?? 0) > this.now().getTime()) {
          return this.result(false, "IN_PROGRESS", "Capture already in progress.", id);
        }
        return this.reconcile(id, opts);
      case "CAPTURE_UNKNOWN":
      case "CAPTURE_PENDING":
        return this.reconcile(id, opts);
      case "ORDER_CREATED":
        break;
    }
    if (!this.gateway || !this.configured) return this.notConfigured(id);
    // Cheap early refusal (no PayPal read); the binding check is repeated atomically before the capture call.
    const early = opts.guard?.() ?? null;
    if (early !== null) {
      this.store.logEvent(id, "CAPTURE_REFUSED_APPROVAL_INVALID", { reason: early }, this.iso());
      return this.result(false, "APPROVAL_INVALID", `The approval behind this payment is no longer valid (${early}); nothing captured.`, id);
    }

    let order: GatewayOrder;
    try {
      order = await this.gateway.getOrder(rec.paypalOrderId!);
    } catch (err) {
      return this.result(false, "LOOKUP_FAILED", `Could not read the order before capture (${errorSummary(err)}); nothing captured.`, id);
    }
    return this.actOnOrder(rec, order, opts);
  }

  /** Decide what to do with a fresh order snapshot for a record that has a PayPal order. */
  private async actOnOrder(rec: PaymentRecord, order: GatewayOrder, opts: GuardOptions = {}): Promise<ServiceResult> {
    const exp = expectationFor(rec, this.payeeMerchantId!);
    const pre = checkBeforeCapture(order, exp);
    switch (pre.state) {
      case "MISMATCH":
        this.move(rec.id, AFTER_ORDER_STATUSES, { status: "NEEDS_REVIEW", reviewReasons: pre.problems, leaseUntil: null }, "PRE_CAPTURE_MISMATCH", { problems: pre.problems });
        return this.result(false, "NEEDS_REVIEW", "PayPal order does not match this record; not captured.", rec.id, { problems: pre.problems });
      case "NOT_APPROVED":
        return this.result(false, "NOT_APPROVED", `Buyer has not approved yet (order ${order.status}).`, rec.id);
      case "CLOSED":
        this.move(rec.id, AFTER_ORDER_STATUSES, { status: "FAILED", paypalOrderStatus: order.status ?? null, leaseUntil: null }, "ORDER_VOIDED");
        return this.result(false, "FAILED", "PayPal order was voided.", rec.id);
      case "ALREADY_COMPLETED":
        return this.finalize(rec.id, order, null);
      case "READY":
        if (opts.noResendAfterUnknown && rec.status !== "ORDER_CREATED") {
          // An earlier capture request may have landed (or may still land); PayPal shows no capture yet. Read only.
          // A stale CAPTURING (e.g. the process stopped mid-request) is recorded as unknown, never as "not sent".
          if (rec.status === "CAPTURING") {
            this.move(rec.id, ["CAPTURING"], { status: "CAPTURE_UNKNOWN", leaseUntil: null }, "CAPTURE_OUTCOME_UNKNOWN_NOT_RESENT", { orderStatus: order.status });
          }
          const problem = opts.guard?.() ?? null;
          if (problem !== null) {
            this.store.logEvent(rec.id, "CAPTURE_REFUSED_APPROVAL_INVALID", { reason: problem, status: rec.status }, this.iso());
            return this.result(false, "APPROVAL_INVALID", `The approval behind this payment is no longer valid (${problem}); no capture request was sent.`, rec.id);
          }
          if (rec.status !== "CAPTURING") this.store.logEvent(rec.id, "CAPTURE_NOT_RESENT", { orderStatus: order.status, status: rec.status }, this.iso());
          return this.result(
            false,
            "CAPTURE_UNKNOWN",
            "PayPal shows no capture of this order as of this lookup. An earlier capture request may have been sent, so TradeProof does not send it again; check again later (read-only). Do not pay again.",
            rec.id,
          );
        }
        const localOk = this.withinRetryWindow(rec.captureStartedAt);
        const paypalOk = this.provablyWithinWindow(rec.captureStartedPayPalAt, order.serverTimeMs);
        if (rec.captureRequestId && !(localOk && paypalOk)) {
          // A retry reuses the old request id. Only allowed if BOTH the local clock and PayPal's clock
          // (Date headers) show it is inside the window: a local clock that lost time or was set back
          // would otherwise understate the elapsed time. Not provable -> no automatic capture.
          const reason = `Earlier capture attempt's outcome unknown and not provably inside PayPal's PayPal-Request-Id retention window (local clock: ${localOk ? "inside" : "outside or unknown"}; PayPal clock: ${paypalOk ? "inside" : "outside or unknown"}); automatic capture stopped.`;
          this.move(rec.id, AFTER_ORDER_STATUSES, { status: "NEEDS_REVIEW", reviewReasons: [reason], leaseUntil: null }, "CAPTURE_RETRY_WINDOW_EXPIRED");
          return this.result(false, "NEEDS_REVIEW", reason, rec.id, { problems: [reason] });
        }
        if (rec.status === "ORDER_CREATED" || rec.status === "CAPTURE_UNKNOWN" || rec.status === "CAPTURING") {
          return this.doCapture(rec, order, opts);
        }
        return this.result(false, "INVALID_STATE", `Record is ${rec.status}.`, rec.id);
    }
  }

  private async doCapture(rec: PaymentRecord, preCaptureOrder: GatewayOrder, opts: GuardOptions = {}): Promise<ServiceResult> {
    const id = rec.id;
    const nowMs = this.now().getTime();
    // Persist the capture request id BEFORE calling PayPal; COALESCE keeps an existing one, so a
    // retry after an unknown outcome reuses the same PayPal-Request-Id.
    const captureGuard = { from: ["ORDER_CREATED", "CAPTURE_UNKNOWN"] as RecordStatus[], staleLeaseStatus: "CAPTURING" as const, nowMs };
    const capturePatch = {
      status: "CAPTURING" as const,
      captureRequestId: this.newId(),
      captureStartedAt: nowMs,
      // Set once (COALESCE): PayPal's clock just before the first capture attempt.
      ...(preCaptureOrder.serverTimeMs !== undefined ? { captureStartedPayPalAt: preCaptureOrder.serverTimeMs } : {}),
      leaseUntil: nowMs + this.leaseMs,
    };
    // The capture decision point: approval validity (if any) and CAPTURING commit together; PayPal is called after.
    let problem: string | null = null;
    const outcome = opts.guard
      ? this.store.transitionChecked(id, captureGuard, capturePatch, this.iso(), () => (problem = opts.guard!()) === null)
      : this.store.transition(id, captureGuard, capturePatch, this.iso()) ? "WON" : "LOST";
    if (outcome === "REFUSED") {
      // Nothing is (re)sent; an earlier unknown outcome stays CAPTURE_UNKNOWN and is still read from PayPal later.
      this.store.logEvent(id, "CAPTURE_REFUSED_APPROVAL_INVALID", { reason: problem, status: rec.status }, this.iso());
      return this.result(false, "APPROVAL_INVALID", `The approval behind this payment is no longer valid (${problem}); no capture request was sent.`, id);
    }
    if (outcome !== "WON") {
      const current = this.store.get(id)!;
      if (current.status === "PAID") return this.result(true, "ALREADY_PAID", "Already paid; no second capture.", id);
      return this.result(false, "IN_PROGRESS", `Capture not started: record is ${current.status}.`, id);
    }
    const claimed = this.store.get(id)!;
    const captureRequestId = claimed.captureRequestId!;
    this.store.logEvent(id, "CAPTURE_ATTEMPT", { paypalRequestId: captureRequestId }, this.iso());

    let captureResponse: GatewayOrder;
    try {
      captureResponse = await this.gateway!.captureOrder(claimed.paypalOrderId!, captureRequestId);
    } catch (err) {
      if (err instanceof GatewayError && err.certainty === "rejected" && err.issue === "ORDER_ALREADY_CAPTURED") {
        // Captured by an earlier attempt: verify from PayPal instead of capturing again.
        return this.verifyFromPayPal(id, null, "ORDER_ALREADY_CAPTURED");
      }
      if (isUncertain(err)) {
        this.move(id, ["CAPTURING"], { status: "CAPTURE_UNKNOWN", leaseUntil: null, lastError: errorSummary(err) }, "CAPTURE_UNKNOWN", { error: errorSummary(err) });
        // Query once now; if PayPal cannot be reached either, the record stays CAPTURE_UNKNOWN.
        return this.verifyFromPayPal(id, null, "after unknown capture outcome");
      }
      this.move(id, ["CAPTURING"], { status: "FAILED", leaseUntil: null, lastError: errorSummary(err) }, "CAPTURE_REJECTED", { error: errorSummary(err) });
      return this.result(false, "FAILED", "PayPal rejected the capture.", id);
    }

    const responseCaptureId = captureResponse.purchaseUnits[0]?.captures[0]?.id ?? null;
    if (responseCaptureId) {
      this.move(id, ["CAPTURING"], { paypalCaptureStatus: captureResponse.purchaseUnits[0]?.captures[0]?.status ?? null }, "CAPTURE_RESPONSE", {
        captureId: responseCaptureId,
        captureStatus: captureResponse.purchaseUnits[0]?.captures[0]?.status,
      });
    }
    // Independent check: do not trust the capture response alone.
    return this.verifyFromPayPal(id, responseCaptureId, "post-capture verification");
  }

  private async verifyFromPayPal(id: string, knownCaptureId: string | null, reason: string): Promise<ServiceResult> {
    const rec = this.store.get(id)!;
    let order: GatewayOrder;
    try {
      order = await this.gateway!.getOrder(rec.paypalOrderId!);
    } catch (err) {
      this.move(id, ["CAPTURING"], { status: "CAPTURE_UNKNOWN", leaseUntil: null, lastError: errorSummary(err) }, "VERIFY_LOOKUP_FAILED", { reason });
      return this.result(false, "CAPTURE_UNKNOWN", "Capture outcome not yet verified; use Reconcile. Do not pay again.", id);
    }
    return this.finalize(id, order, knownCaptureId);
  }

  private finalize(id: string, order: GatewayOrder, knownCaptureId: string | null): ServiceResult {
    const rec = this.store.get(id)!;
    const exp = expectationFor(rec, this.payeeMerchantId!);
    if (knownCaptureId) exp.captureId = rec.paypalCaptureId ?? knownCaptureId;
    const v = verifyCapturedOrder(order, exp);
    const detail = { verdict: v.verdict, orderStatus: v.orderStatus, captureId: v.captureId, captureStatus: v.captureStatus, problems: v.problems };
    const common = { paypalOrderStatus: v.orderStatus ?? null, paypalCaptureStatus: v.captureStatus ?? null, leaseUntil: null };

    switch (v.verdict) {
      case "PAID": {
        this.move(
          id,
          AFTER_ORDER_STATUSES,
          { ...common, status: "PAID", paypalCaptureId: v.captureId!, paidAt: this.iso(), lastError: null, reviewReasons: [] },
          "VERIFIED_PAID",
          detail,
        );
        const after = this.store.get(id)!;
        return after.status === "PAID"
          ? this.result(true, "PAID", "Payment captured and verified against PayPal.", id)
          : this.result(false, "INVALID_STATE", `Verification passed but record is ${after.status}.`, id);
      }
      case "PENDING":
        this.move(id, AFTER_ORDER_STATUSES, { ...common, status: "CAPTURE_PENDING", paypalCaptureId: v.captureId! }, "CAPTURE_PENDING", detail);
        return this.result(false, "CAPTURE_PENDING", "PayPal reports the capture as PENDING; not paid yet.", id);
      case "DECLINED":
        this.move(id, AFTER_ORDER_STATUSES, { ...common, status: "FAILED", lastError: `capture ${v.captureStatus}` }, "CAPTURE_DECLINED", detail);
        return this.result(false, "FAILED", `Capture ${v.captureStatus}.`, id);
      case "NOT_CAPTURED":
        if (rec.status === "CAPTURING") {
          this.move(id, ["CAPTURING"], { ...common, status: "CAPTURE_UNKNOWN" }, "VERIFY_NOT_CAPTURED", detail);
        }
        return this.result(false, rec.status === "ORDER_CREATED" ? "NOT_APPROVED" : "CAPTURE_UNKNOWN", "PayPal shows no capture yet; use Reconcile.", id);
      case "MISMATCH":
        this.move(id, AFTER_ORDER_STATUSES, { ...common, status: "NEEDS_REVIEW", reviewReasons: v.problems }, "VERIFY_MISMATCH", detail);
        return this.result(false, "NEEDS_REVIEW", "PayPal data does not match the expected payment; NOT marked paid.", id, { problems: v.problems });
    }
  }

  // ---------- 4. reconcile (after restart, closed window, timeout, client error) ----------

  async reconcile(id: string, opts: GuardOptions = {}): Promise<ServiceResult> {
    const rec = this.store.get(id);
    if (!rec) return this.result(false, "NOT_FOUND", "Unknown local record.", null);
    if (rec.status === "NEW") return this.result(false, "NOT_READY", "No PayPal order yet.", id);
    if (rec.status === "FAILED") return this.result(false, "FAILED", rec.lastError ?? "Failed.", id);
    if (!this.gateway || !this.configured) return this.notConfigured(id);

    if (rec.status === "ORDER_CREATING") {
      if ((rec.leaseUntil ?? 0) > this.now().getTime()) return this.result(false, "IN_PROGRESS", "Order creation in progress.", id);
      if (opts.noResendAfterUnknown) {
        // A PayPal order cannot be looked up without its id, and reconcile sends nothing.
        return this.result(false, "CREATE_UNKNOWN", "Order creation outcome unknown. Reconcile only reads PayPal and cannot look up an order without its id; nothing was sent. Pressing Create PayPal order repeats the same create request (same PayPal-Request-Id, no money moves).", id);
      }
      // Same PayPal-Request-Id → PayPal returns the order from the earlier attempt instead of a new one.
      return this.createPayPalOrder(id, opts);
    }
    if (rec.status === "CAPTURING" && (rec.leaseUntil ?? 0) > this.now().getTime()) {
      return this.result(false, "IN_PROGRESS", "Capture in progress.", id);
    }

    let order: GatewayOrder;
    try {
      order = await this.gateway.getOrder(rec.paypalOrderId!);
    } catch (err) {
      return this.result(false, "LOOKUP_FAILED", `PayPal lookup failed (${errorSummary(err)}); state unchanged.`, id);
    }
    this.store.logEvent(id, "RECONCILE_LOOKUP", { orderStatus: order.status }, this.iso());

    if (rec.status === "PAID" || rec.status === "NEEDS_REVIEW") {
      // Report only: a reviewed or paid record is never changed automatically.
      const v = verifyCapturedOrder(order, expectationFor(rec, this.payeeMerchantId!));
      const ok = rec.status === "PAID" && v.verdict === "PAID";
      return this.result(ok, rec.status === "PAID" ? "ALREADY_PAID" : "NEEDS_REVIEW", ok ? "Re-verified against PayPal: still paid." : `PayPal verdict ${v.verdict}.`, id, { problems: v.problems });
    }
    return this.actOnOrder(rec, order, opts);
  }
}
