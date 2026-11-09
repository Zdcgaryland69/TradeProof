// HTTP layer for approvals (local dev only; same guard as the other development APIs).
//
//   GET  /api/procurements/:id/approvals?series=&version=&run=[&baseRun=]   preview (computed, nothing stored)
//   GET  /api/procurements/:id/approvals                                      list with current validity
//   POST /api/procurements/:id/approvals                                      approve  {seriesId, versionId, runId, baseRunId?, previewDigest, confirmed[]}
//   GET  /api/procurements/:id/approvals/:approvalId                          snapshot + validity + payment readiness
//   POST /api/procurements/:id/approvals/:approvalId/revoke                   {note}
//   POST /api/procurements/:id/approvals/:approvalId/payment[/order|/capture|/reconcile]
//   POST /api/procurements/:id/quotes/:seriesId/versions/:versionId/requirement-classifications  {subject, decision, reason, excerpt?}
//
//   POST /api/procurements/:id/approvals/:approvalId/payment/mock-approve                 MOCK mode only (simulated buyer approval)
//
// POSTs carry an `Idempotency-Key` header (UUID). Amount, currency, payee and terms are never accepted from the
// browser. The payment steps are refused unless approval payments are switched on by the server's environment
// (payment-mode.ts: TRADEPROOF_APPROVAL_PAYMENTS=sandbox on the main database, or =mock on a database copy).

import { QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { APP_DB_PATH, DEFAULT_APP_DB_PATH } from "../db/location.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { HTTP_STATUS } from "../payments/http.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { ApprovalService, PaymentOutcome } from "./service.ts";
import { approvalPaymentMode, paymentsEnabledIn } from "./payment-mode.ts";
import { APPROVAL_ID } from "./store.ts";

export type ApprovalSource = ApprovalService | (() => ApprovalService);
export interface ApprovalHttpOptions extends GuardOptions {
  /** Payment steps for approvals (PayPal Sandbox or MOCK). Off unless explicitly enabled. */
  paymentsEnabled?: boolean;
  /** Why the switch is refused (shown with 409), if it is. */
  paymentsRefusedReason?: string | null;
}
const resolve = (s: ApprovalSource) => (typeof s === "function" ? s() : s);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request, quote version, run or approval." });
const RUN_ID = /^qx_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 16 * 1024;

export const currentApprovalPaymentMode = () => approvalPaymentMode(process.env, APP_DB_PATH, DEFAULT_APP_DB_PATH);
export const approvalPaymentsEnabled = () => paymentsEnabledIn(currentApprovalPaymentMode());
export const approvalPaymentsRefusedReason = () => {
  const m = currentApprovalPaymentMode();
  return m.mode === "REFUSED" ? m.reason : null;
};

async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return json(413, { ok: false, code: "TOO_LARGE", message: "Body too large." });
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return json(422, { ok: false, code: "VALIDATION_FAILED", message: "Body must be a JSON object." });
    return v as Record<string, unknown>;
  } catch {
    return json(422, { ok: false, code: "VALIDATION_FAILED", message: "Body is not valid JSON." });
  }
}

const keyOf = (req: Request) => req.headers.get("idempotency-key") ?? "";

export async function handlePreview(req: Request, requestId: string, source: ApprovalSource, opts: ApprovalHttpOptions): Promise<Response> {
  const who = guard(req, opts, "Approval API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId)) return notFound();
  const p = new URL(req.url).searchParams;
  // 3 Nov: read-only approval state for ONE quote version (Quotes-page entry). Uses readFacts: validity is computed
  // without writing an INVALIDATED event, an audit row or anything else; it is display only — approving and paying
  // are decided by the approval page and the server as before.
  if (p.has("statusFor")) {
    const versionId = p.get("statusFor") ?? "";
    if ([...p.keys()].length !== 1 || !QUOTE_VERSION_ID.test(versionId)) return json(422, { ok: false, code: "VALIDATION_FAILED", message: "statusFor must be the only parameter and a quote version id." });
    const facts = resolve(source).readFacts(who, requestId, null);
    if (!facts) return notFound();
    // 5 Nov: the latest payment record of the approval (a non-FAILED one if any), as stored — status and SKU only, so the
    // Quotes page can show "paid" apart from "approved" and MOCK apart from Sandbox. Read from the same facts; no write.
    const paymentOf = (ps: (typeof facts.approvals)[number]["payments"]) => {
      const p = [...ps].reverse().find((x) => x.status !== "FAILED") ?? ps[ps.length - 1] ?? null;
      return p ? { status: p.status, sku: p.sku, amountMinor: p.amountMinor, currency: p.currency, paidAt: p.paidAt } : null;
    };
    const view = (a: (typeof facts.approvals)[number]) => ({
      payment: paymentOf(a.payments),
      id: a.approval.id,
      state: a.validity.state,
      reasons: a.validity.reasons,
      createdAt: a.approval.createdAt,
      amountMinor: a.approval.amountMinor,
      currency: a.approval.currency,
      versionNumber: a.approval.snapshot.quote.versionNumber,
      seriesId: a.approval.seriesId,
      versionId: a.approval.versionId,
      runId: a.approval.runId,
    });
    const here = facts.approvals.filter((a) => a.approval.versionId === versionId).map(view);
    const otherActive = facts.approvals.filter((a) => a.approval.versionId !== versionId && a.validity.state === "ACTIVE").map(view);
    return json(200, { ok: true, statusFor: versionId, here, otherActive });
  }
  const unknown = [...p.keys()].filter((k) => !["series", "version", "run", "baseRun"].includes(k));
  if (unknown.length > 0) return json(422, { ok: false, code: "VALIDATION_FAILED", message: `Unknown parameter(s): ${unknown.join(", ")}.` });
  const svc = resolve(source);
  if (![...p.keys()].length) {
    const list = svc.list(who, requestId);
    return list ? json(200, { ok: true, approvals: list }) : notFound();
  }
  const series = p.get("series") ?? "";
  const version = p.get("version") ?? "";
  const run = p.get("run") ?? "";
  const baseRun = p.get("baseRun");
  if (!QUOTE_SERIES_ID.test(series) || !QUOTE_VERSION_ID.test(version) || !RUN_ID.test(run) || (baseRun !== null && !RUN_ID.test(baseRun))) {
    return json(422, { ok: false, code: "VALIDATION_FAILED", message: "series, version and run must be ids (baseRun optional)." });
  }
  const out = svc.preview(who, requestId, { seriesId: series, versionId: version, runId: run, baseRunId: baseRun });
  return out.status === "OK" ? json(200, { ok: true, evaluation: out.evaluation, ids: out.ids }) : notFound();
}

export async function handleApprove(req: Request, requestId: string, source: ApprovalSource, opts: ApprovalHttpOptions): Promise<Response> {
  const who = guard(req, opts, "Approval API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId)) return notFound();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const out = resolve(source).approve(who, requestId, body, keyOf(req));
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return json(422, { ok: false, code: "VALIDATION_FAILED", message: out.message });
    case "KEY_REUSED":
      return json(409, { ok: false, code: "KEY_REUSED", message: "This request key was already used for a different approval request." });
    case "BLOCKED":
      return json(422, { ok: false, code: "BLOCKED", message: "Approval is blocked by the reasons listed.", evaluation: out.evaluation });
    case "BASIS_CHANGED":
      return json(409, { ok: false, code: "BASIS_CHANGED", message: "The conditions changed since this preview. Review the new preview; nothing was approved.", evaluation: out.evaluation });
    case "CONFIRMATIONS_MISMATCH":
      return json(422, { ok: false, code: "CONFIRMATIONS_MISMATCH", message: "Every listed confirmation of this exact preview is required, and nothing else.", missing: out.missing, unexpected: out.unexpected, evaluation: out.evaluation });
    case "FORBIDDEN":
      return json(403, { ok: false, code: "FORBIDDEN", message: "Only an approver currently assigned to this request can approve it. Buyers cannot approve their own requests." });
    case "ALREADY_APPROVED":
      return json(409, { ok: false, code: "ALREADY_APPROVED", message: "Another approval of this request is active. Revoke it first.", approval: out.approval });
    case "CREATED":
      return json(201, { ok: true, status: out.status, approval: out.approval });
    case "REPLAYED":
    case "EXISTING":
      return json(200, { ok: true, status: out.status, approval: out.approval });
  }
}

export async function handleView(req: Request, requestId: string, approvalId: string, source: ApprovalSource, opts: ApprovalHttpOptions): Promise<Response> {
  const who = guard(req, opts, "Approval API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !APPROVAL_ID.test(approvalId)) return notFound();
  const svc = resolve(source);
  const view = svc.view(who, requestId, approvalId);
  if (!view) return notFound();
  return json(200, { ok: true, ...view, readiness: svc.paymentReadiness(who, requestId, approvalId), paymentsEnabled: !!opts.paymentsEnabled });
}

export async function handleRevoke(req: Request, requestId: string, approvalId: string, source: ApprovalSource, opts: ApprovalHttpOptions): Promise<Response> {
  const who = guard(req, opts, "Approval API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !APPROVAL_ID.test(approvalId)) return notFound();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const extra = Object.keys(body).filter((k) => k !== "note");
  if (extra.length > 0) return json(422, { ok: false, code: "VALIDATION_FAILED", message: `Unknown field(s): ${extra.join(", ")}.` });
  const out = resolve(source).revoke(who, requestId, approvalId, body.note, keyOf(req));
  if (out.status === "NOT_FOUND") return notFound();
  if (out.status === "INVALID") return json(422, { ok: false, code: "VALIDATION_FAILED", message: out.message });
  return json(200, { ok: true, status: out.status, view: out.view });
}

export async function handleClassify(req: Request, requestId: string, seriesId: string, versionId: string, source: ApprovalSource, opts: ApprovalHttpOptions): Promise<Response> {
  const who = guard(req, opts, "Approval API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !QUOTE_VERSION_ID.test(versionId)) return notFound();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const out = resolve(source).classify(who, requestId, seriesId, versionId, body, keyOf(req));
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return json(422, { ok: false, code: "VALIDATION_FAILED", message: out.message });
    case "KEY_REUSED":
      return json(409, { ok: false, code: "KEY_REUSED", message: "This request key was already used for a different classification." });
    case "STALE":
      return json(409, {
        ok: false,
        code: "CLASSIFICATION_CHANGED",
        message: out.current
          ? "This requirement's classification changed since you opened it (or your form did not name the classification it replaces). Nothing was saved — reload to see the current one."
          : "This requirement has no classification yet, so there is nothing to replace. Nothing was saved — reload the page.",
        current: out.current,
      });
    default:
      return json(out.status === "CREATED" ? 201 : 200, { ok: true, status: out.status, classification: out.classification });
  }
}

export type PaymentStepName = "start" | "order" | "capture" | "reconcile";

function paymentResponse(out: PaymentOutcome): Response {
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "NOT_PAYABLE":
      return json(409, { ok: false, code: "APPROVAL_NOT_PAYABLE", message: "This approval cannot authorise a payment (it was made before sign-in existed, without an authenticated approver). A new approval by an assigned approver is needed.", reason: out.reason });
    case "NO_PAYMENT":
      return json(409, { ok: false, code: "NO_PAYMENT", message: "Start the payment of this approval first." });
    case "APPROVAL_INVALID":
      return json(409, { ok: false, code: "APPROVAL_INVALID", message: "This approval is no longer valid; no payment step was taken.", validity: out.validity });
    case "ALREADY_PAID":
    case "PAYMENT_OUTCOME_OPEN":
      return json(409, { ok: false, code: out.status, message: "Another payment of this request is paid or has an open outcome.", recordId: out.recordId });
    case "CREATED":
    case "EXISTING":
      return json(out.status === "CREATED" ? 201 : 200, { ok: true, status: out.status, payment: out.payment });
    case "PAYPAL":
      return json(HTTP_STATUS[out.result.code], { ...out.result });
  }
}

export async function handlePaymentStep(req: Request, requestId: string, approvalId: string, step: PaymentStepName, source: ApprovalSource, opts: ApprovalHttpOptions): Promise<Response> {
  const who = guard(req, opts, "Approval payment API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !APPROVAL_ID.test(approvalId)) return notFound();
  if (!opts.paymentsEnabled) {
    return json(409, {
      ok: false,
      code: "PAYMENTS_NOT_ENABLED",
      message: `Payment for approvals is not enabled on this server${opts.paymentsRefusedReason ? ` (${opts.paymentsRefusedReason})` : ""}. Nothing was created and PayPal was not called.`,
    });
  }
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const allowed = step === "capture" ? ["orderId"] : [];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return json(422, { ok: false, code: "VALIDATION_FAILED", message: `Unknown field(s): ${extra.join(", ")}. The amount comes from the approval only.` });
  const svc = resolve(source);
  switch (step) {
    case "start":
      return paymentResponse(svc.startPayment(who, requestId, approvalId));
    case "order":
      return paymentResponse(await svc.createOrder(who, requestId, approvalId));
    case "capture":
      return paymentResponse(await svc.capture(who, requestId, approvalId, typeof body.orderId === "string" ? body.orderId : undefined));
    case "reconcile":
      return paymentResponse(await svc.reconcile(who, requestId, approvalId));
  }
}

/** MOCK mode only: simulate the buyer approving the approval's current MOCK order. 404 in every other mode. */
export async function handleMockApprove(
  req: Request,
  requestId: string,
  approvalId: string,
  source: ApprovalSource,
  opts: ApprovalHttpOptions & { mock: { approve(orderId: string): boolean } | null },
): Promise<Response> {
  const who = guard(req, opts, "Approval payment API");
  if (who instanceof Response) return who;
  if (!opts.mock || !PROCUREMENT_ID.test(requestId) || !APPROVAL_ID.test(approvalId)) return notFound();
  const body = await readBody(req);
  if (body instanceof Response) return body;
  if (Object.keys(body).length > 0) return json(422, { ok: false, code: "VALIDATION_FAILED", message: "No fields are accepted." });
  const current = resolve(source).currentPayment(who, requestId, approvalId);
  if (!current?.paypalOrderId) return json(409, { ok: false, code: "NO_ORDER", message: "No MOCK order for this approval yet." });
  opts.mock.approve(current.paypalOrderId);
  return json(200, { ok: true, code: "MOCK_APPROVED", message: `MOCK: buyer approval simulated for ${current.paypalOrderId}. No PayPal request.`, orderId: current.paypalOrderId });
}
