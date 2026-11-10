// Approval → payment closed loop (30 Oct). Temporary databases only; SYNTHETIC case A (USD 12.00, 100 % once)
// replayed through the MOCK extraction test double (no model, no token count, no budget) and MOCK PayPal gateways
// (tests/mock-paypal.ts and the file-backed src/server/payments/mock-gateway.ts) — no network, no real Sandbox.
//
// Covers: a valid approval pays (MOCK); invalidated / revoked approvals refuse every step; the browser cannot set the
// amount, currency, payee or order; a basis change between order and capture; repeated and parallel requests; capture
// outcome unknown (never re-sent while the approval is valid either); restart recovery (stale CAPTURING, PAID); unknown
// order creation (reconcile sends nothing); the payment switch; the MOCK gateway's persistence; the MOCK-only route.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { recordToInput } from "../src/lib/procurement.ts";
import { handleMockApprove, handlePaymentStep, type PaymentStepName } from "../src/server/approval/http.ts";
import { approvalPaymentMode, paymentLabel, paymentsEnabledIn } from "../src/server/approval/payment-mode.ts";
import { ApprovalService } from "../src/server/approval/service.ts";
import { ApprovalStore } from "../src/server/approval/store.ts";
import { ClarificationStore } from "../src/server/clarification/store.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { FileMockPayPal } from "../src/server/payments/mock-gateway.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { GatewayError, type PayPalGateway } from "../src/server/payments/types.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { ReplyService } from "../src/server/replies/service.ts";
import { ReplyStore } from "../src/server/replies/store.ts";
import { A, P, replayModel, replayService, reviewAll, seedCase, type Seeded } from "./helpers/approval-fixtures.ts";
import { MOCK_PAYEE, MockPayPal } from "./mock-paypal.ts";
import { testGate } from "./helpers/principals.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-approval-payment-test-"));
});
after(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** All stores and services on one DB file. Call again with the same path and gateway to simulate a restart. */
function world(path = join(dir, `pay-${++counter}.sqlite`), paypal: PayPalGateway & { calls?: unknown } = new MockPayPal(), clock = { now: new Date("2026-10-30T03:00:00Z") }) {
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const cs = new ClarificationStore(path);
  const rs = new ReplyStore(path);
  const aps = new ApprovalStore(path);
  const pay = new PaymentStore(path);
  open.push(ps, qs, es, cs, rs, aps, pay);
  const model = replayModel();
  const svc = replayService(es, model);
  const payments = new PaymentService({ store: pay, gateway: paypal, payeeMerchantId: MOCK_PAYEE, now: () => clock.now, leaseMs: 60_000 });
  const payee = { configured: true, merchantId: MOCK_PAYEE as string | null };
  const label = { sku: "TP-APPROVAL", suffix: "(Sandbox)" };
  const approvals = new ApprovalService({ store: aps, extraction: es, procurement: ps, replies: new ReplyService(rs, cs), replyStore: rs, drafts: cs, payments: () => payments, payee: () => payee, now: () => clock.now, paymentLabel: () => label });
  return { path, ps, qs, es, svc, model, paypal, payments, approvals, clock, label };
}
type World = ReturnType<typeof world>;

async function approvedA(w: World) {
  const s = await seedCase(w, "A", `pay ${counter}`);
  reviewAll(w, s);
  const p = w.approvals.preview(P, s.request.id, { seriesId: s.seriesId, versionId: s.versionId, runId: s.run.id, baseRunId: null });
  assert.equal(p.status, "OK");
  const e = (p as { evaluation: { status: string; digest: string; confirmKeys: string[] } }).evaluation;
  assert.equal(e.status, "READY");
  const out = w.approvals.approve(A, s.request.id, { seriesId: s.seriesId, versionId: s.versionId, runId: s.run.id, baseRunId: null, previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID());
  assert.equal(out.status, "CREATED");
  return { s, approvalId: (out as { approval: { id: string } }).approval.id };
}

const URL_BASE = "http://127.0.0.1:3000/api/procurements";
function http(w: World, s: Seeded, approvalId: string, step: PaymentStepName, body?: unknown, paymentsEnabled = true) {
  const path = step === "start" ? "" : `/${step}`;
  return handlePaymentStep(
    new Request(`${URL_BASE}/${s.request.id}/approvals/${approvalId}/payment${path}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", "idempotency-key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    s.request.id,
    approvalId,
    step,
    w.approvals,
    { enabled: true, auth: testGate(), paymentsEnabled },
  );
}

const rows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (t: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
    return { records: n("sandbox_payment_records"), links: n("approval_payments"), events: n("approval_events") };
  } finally {
    db.close();
  }
};
const mock = (w: World) => w.paypal as MockPayPal;
const result = (o: unknown) => (o as { result: { code: string; orderId?: string; record: { status: string; sku: string; paypalOrderId: string | null } } }).result;

function editQuantity(w: World, requestId: string, value: string) {
  const r = w.ps.get(requestId)!;
  const input = recordToInput(r);
  input.items[0].quantity = value;
  const v = validateProcurementInput(input, "update");
  assert.ok(v.ok);
  assert.equal(w.ps.update(requestId, r.revision, v.value).status, "UPDATED");
}

describe("approval payment: valid and invalid approvals (MOCK PayPal)", () => {
  test("valid approval → MOCK PAID over HTTP; amount, currency and payee only from the stored approval", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    const start = await http(w, s, approvalId, "start", {});
    assert.equal(start.status, 201);
    const order = await http(w, s, approvalId, "order", {});
    assert.equal(order.status, 200);
    const orderId = ((await order.json()) as { orderId: string }).orderId;
    assert.deepEqual(mock(w).calls.create[0].input.amount, { currencyCode: "USD", value: "12.00" });
    mock(w).approve(orderId);
    const cap = await http(w, s, approvalId, "capture", { orderId });
    const body = (await cap.json()) as { code: string; record: { status: string; amountMinor: number; currency: string; sku: string } };
    assert.equal(body.code, "PAID");
    assert.deepEqual([body.record.status, body.record.amountMinor, body.record.currency, body.record.sku], ["PAID", 1200, "USD", "TP-APPROVAL"]);
    assert.equal(mock(w).totalCaptures(), 1);
    assert.deepEqual(rows(w.path), { records: 1, links: 1, events: 0 });
  });

  test("revoked or invalidated approval → payment start, order and capture refused; nothing sent to PayPal", async () => {
    const w = world();
    const a = await approvedA(w);
    w.approvals.revoke(P, a.s.request.id, a.approvalId, "stop (test)", randomUUID());
    const r1 = await http(w, a.s, a.approvalId, "start", {});
    assert.equal(r1.status, 409);
    assert.equal(((await r1.json()) as { code: string }).code, "APPROVAL_INVALID");
    assert.equal(rows(w.path).records, 0);

    const b = await approvedA(w);
    assert.equal((await http(w, b.s, b.approvalId, "start", {})).status, 201);
    editQuantity(w, b.s.request.id, "21");
    assert.equal(result(await w.approvals.createOrder(P, b.s.request.id, b.approvalId)).code, "APPROVAL_INVALID");
    assert.equal(mock(w).calls.create.length, 0, "no create request for an invalidated approval");
    assert.equal(w.approvals.view(P, b.s.request.id, b.approvalId)!.validity.state, "INVALIDATED");
    assert.equal(w.approvals.startPayment(P, b.s.request.id, b.approvalId).status, "APPROVAL_INVALID");
  });

  test("tampering: amount, currency, payee or record fields are refused at every step; a foreign order id captures nothing", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    for (const step of ["start", "order", "capture", "reconcile"] as const) {
      for (const extra of [{ amount: "0.01" }, { amountMinor: 1 }, { currency: "JPY" }, { payee: "ATTACKER" }, { payeeMerchantId: "ATTACKER" }, { recordId: "tp_x" }]) {
        const res = await http(w, s, approvalId, step, extra);
        assert.equal(res.status, 422, `${step} ${JSON.stringify(extra)}`);
      }
    }
    assert.equal(rows(w.path).records, 0);
    assert.equal(mock(w).calls.create.length + mock(w).calls.capture.length, 0);
    await http(w, s, approvalId, "start", {});
    const o = result(await w.approvals.createOrder(P, s.request.id, approvalId));
    mock(w).approve(o.orderId!);
    mock(w).addForeignOrder("FOREIGN0001", "0.01");
    mock(w).approve("FOREIGN0001");
    const res = await http(w, s, approvalId, "capture", { orderId: "FOREIGN0001" });
    assert.equal(((await res.json()) as { code: string }).code, "ORDER_MISMATCH");
    assert.equal(mock(w).calls.capture.length, 0);
    assert.equal(mock(w).calls.create[0].input.amount.value, "12.00");
  });

  test("basis changes after the order and before the capture (new review) → capture refused; ORDER_CREATED kept; no capture request", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    w.approvals.startPayment(P, s.request.id, approvalId);
    const o = result(await w.approvals.createOrder(P, s.request.id, approvalId));
    mock(w).approve(o.orderId!);
    const last = w.es.reviews(s.run.id).filter((r) => r.fieldPath === "total").at(-1)!.id;
    w.svc.review(P, s.request.id, s.seriesId, s.versionId, s.run.id, { idempotencyKey: randomUUID(), fieldPath: "total", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: last });
    const cap = result(await w.approvals.capture(P, s.request.id, approvalId, o.orderId));
    assert.equal(cap.code, "APPROVAL_INVALID");
    assert.equal(cap.record.status, "ORDER_CREATED");
    assert.equal(mock(w).calls.capture.length, 0);
    assert.deepEqual(w.approvals.view(P, s.request.id, approvalId)!.validity.reasons, ["REVIEWS_CHANGED"]);
  });
});

describe("approval payment: duplicates, unknown outcomes, restart (MOCK PayPal)", () => {
  test("repeated and parallel requests: one record, one PayPal order, one capture", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    const starts = await Promise.all(Array.from({ length: 5 }, () => http(w, s, approvalId, "start", {})));
    assert.deepEqual(starts.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
    mock(w).createDelayMs = 30;
    const orders = await Promise.all(Array.from({ length: 5 }, () => w.approvals.createOrder(P, s.request.id, approvalId)));
    assert.equal(mock(w).calls.create.length, 1, "parallel order clicks send one create request");
    const ids = new Set(orders.map((o) => result(o).orderId).filter(Boolean));
    assert.equal(ids.size, 1);
    const orderId = [...ids][0]!;
    assert.equal(result(await w.approvals.createOrder(P, s.request.id, approvalId)).orderId, orderId, "a later click reuses the order");
    mock(w).approve(orderId);
    mock(w).captureDelayMs = 30;
    const caps = await Promise.all(Array.from({ length: 5 }, () => w.approvals.capture(P, s.request.id, approvalId, orderId)));
    assert.equal(mock(w).calls.capture.length, 1, "parallel capture clicks send one capture request");
    assert.ok(caps.map((c) => result(c).code).includes("PAID"));
    assert.ok(caps.every((c) => ["PAID", "ALREADY_PAID", "IN_PROGRESS"].includes(result(c).code)));
    assert.equal(result(await w.approvals.capture(P, s.request.id, approvalId, orderId)).code, "ALREADY_PAID");
    assert.equal(w.approvals.startPayment(P, s.request.id, approvalId).status, "EXISTING");
    assert.equal(mock(w).totalCaptures(), 1);
    assert.equal(rows(w.path).records, 1);
  });

  test("capture outcome unknown with a VALID approval: Capture again and Check send no capture; a capture PayPal shows later is recorded PAID", async () => {
    // (a) PayPal never processed it.
    const w = world();
    const a = await approvedA(w);
    w.approvals.startPayment(P, a.s.request.id, a.approvalId);
    const o = result(await w.approvals.createOrder(P, a.s.request.id, a.approvalId));
    mock(w).approve(o.orderId!);
    mock(w).captureFaults.push("timeout-before-processing");
    assert.equal(result(await w.approvals.capture(P, a.s.request.id, a.approvalId, o.orderId)).code, "CAPTURE_UNKNOWN");
    assert.equal(mock(w).calls.capture.length, 1);
    const again = result(await w.approvals.capture(P, a.s.request.id, a.approvalId, o.orderId));
    const check = result(await w.approvals.reconcile(P, a.s.request.id, a.approvalId));
    assert.deepEqual([again.code, again.record.status, check.code, check.record.status], ["CAPTURE_UNKNOWN", "CAPTURE_UNKNOWN", "CAPTURE_UNKNOWN", "CAPTURE_UNKNOWN"]);
    assert.equal(mock(w).calls.capture.length, 1, "the unknown capture is never re-sent");
    assert.equal(w.approvals.view(P, a.s.request.id, a.approvalId)!.validity.state, "ACTIVE");
    // A second approval / payment for the request is not possible while the outcome is open.
    assert.equal(w.approvals.paymentReadiness(P, a.s.request.id, a.approvalId)!.payments[0].status, "CAPTURE_UNKNOWN");

    // (b) PayPal captured, the response and the follow-up read were lost.
    const w2 = world();
    const b = await approvedA(w2);
    w2.approvals.startPayment(P, b.s.request.id, b.approvalId);
    const o2 = result(await w2.approvals.createOrder(P, b.s.request.id, b.approvalId));
    mock(w2).approve(o2.orderId!);
    mock(w2).captureFaults.push("timeout-after-processing");
    const original = mock(w2).captureOrder.bind(mock(w2));
    mock(w2).captureOrder = async (orderId, requestId) => {
      try {
        return await original(orderId, requestId);
      } finally {
        mock(w2).getFailures = 1;
      }
    };
    assert.equal(result(await w2.approvals.capture(P, b.s.request.id, b.approvalId, o2.orderId)).code, "CAPTURE_UNKNOWN");
    const found = result(await w2.approvals.reconcile(P, b.s.request.id, b.approvalId));
    assert.equal(found.code, "PAID");
    assert.equal(mock(w2).calls.capture.length, 1);
    assert.equal(mock(w2).totalCaptures(), 1);
  });

  test("restart while a capture was in flight: the stale CAPTURING record is read only (→ CAPTURE_UNKNOWN), never re-captured; a PAID record stays PAID", async () => {
    const paypal = new MockPayPal();
    const clock = { now: new Date("2026-10-30T03:00:00Z") };
    const w = world(undefined, paypal, clock);
    const { s, approvalId } = await approvedA(w);
    w.approvals.startPayment(P, s.request.id, approvalId);
    const o = result(await w.approvals.createOrder(P, s.request.id, approvalId));
    paypal.approve(o.orderId!);
    paypal.hangCapture = true; // the process "dies" while the capture request is out
    void w.approvals.capture(P, s.request.id, approvalId, o.orderId);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.approvals.currentPayment(P, s.request.id, approvalId)!.status, "CAPTURING");
    assert.equal(result(await w.approvals.reconcile(P, s.request.id, approvalId)).code, "IN_PROGRESS", "inside the lease nothing is read or sent");
    assert.equal(paypal.calls.capture.length, 1);

    // Restart: new stores and services on the same file; the (MOCK) PayPal side keeps its state; the lease has expired.
    paypal.hangCapture = false;
    clock.now = new Date("2026-10-30T03:05:00Z");
    const r = world(w.path, paypal, clock);
    const after = result(await r.approvals.capture(P, s.request.id, approvalId, o.orderId));
    assert.deepEqual([after.code, after.record.status], ["CAPTURE_UNKNOWN", "CAPTURE_UNKNOWN"]);
    assert.equal(result(await r.approvals.reconcile(P, s.request.id, approvalId)).code, "CAPTURE_UNKNOWN");
    assert.equal(paypal.calls.capture.length, 1, "no capture request after the restart");

    // A paid record survives a restart unchanged and is never paid again.
    const w3 = world();
    const p = await approvedA(w3);
    w3.approvals.startPayment(P, p.s.request.id, p.approvalId);
    const o3 = result(await w3.approvals.createOrder(P, p.s.request.id, p.approvalId));
    mock(w3).approve(o3.orderId!);
    assert.equal(result(await w3.approvals.capture(P, p.s.request.id, p.approvalId, o3.orderId)).code, "PAID");
    const r3 = world(w3.path, w3.paypal);
    assert.equal(result(await r3.approvals.capture(P, p.s.request.id, p.approvalId, o3.orderId)).code, "ALREADY_PAID");
    assert.equal(r3.approvals.startPayment(P, p.s.request.id, p.approvalId).status, "EXISTING");
    assert.equal(mock(w3).calls.capture.length, 1);
    assert.equal(rows(w3.path).records, 1);
  });

  test("order creation outcome unknown: Check sends nothing; an explicit Create repeats the same PayPal-Request-Id → one order", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    w.approvals.startPayment(P, s.request.id, approvalId);
    const create = mock(w).createOrder.bind(mock(w));
    let lose = true;
    mock(w).createOrder = async (input, requestId) => {
      const order = await create(input, requestId);
      if (lose) {
        lose = false;
        throw new GatewayError("MOCK create: no definite response (TimeoutError)", "uncertain");
      }
      return order;
    };
    assert.equal(result(await w.approvals.createOrder(P, s.request.id, approvalId)).code, "CREATE_UNKNOWN");
    const check = result(await w.approvals.reconcile(P, s.request.id, approvalId));
    assert.deepEqual([check.code, check.record.status], ["CREATE_UNKNOWN", "ORDER_CREATING"]);
    assert.equal(mock(w).calls.create.length, 1, "Check sent no create request");
    const again = result(await w.approvals.createOrder(P, s.request.id, approvalId));
    assert.equal(again.code, "ORDER_READY");
    assert.equal(mock(w).calls.create.length, 2);
    assert.equal(mock(w).calls.create[0].requestId, mock(w).calls.create[1].requestId, "same PayPal-Request-Id");
    assert.equal(new Set(mock(w).calls.create.map((c) => c.requestId)).size, 1);
  });
});

// L4 (10 Nov review): request A reads the record (ORDER_CREATED) and waits for its pre-capture order lookup; meanwhile
// request B captures and ends CAPTURE_UNKNOWN. A must not send a capture when it resumes, even with the same
// PayPal-Request-Id. Deterministic: A's first getOrder is held at a gate (no timing races). MOCK PayPal only.
describe("approval payment: capture race after an unknown outcome (deterministic gate, MOCK PayPal)", () => {
  /** Holds the NEXT getOrder call (request A's) until release(). late-read: reads after release; late-response:
   * reads at once (before B) and delivers the stale snapshot after release. */
  function gateNextGetOrder(w: World, mode: "late-read" | "late-response") {
    const m = mock(w);
    const original = m.getOrder.bind(m);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let armed = true;
    m.getOrder = async (orderId) => {
      if (!armed) return original(orderId);
      armed = false;
      if (mode === "late-response") {
        const snapshot = await original(orderId);
        reached();
        await gate;
        return snapshot;
      }
      reached();
      await gate;
      return original(orderId);
    };
    return { atGate, release };
  }

  async function orderReady(w: World) {
    const a = await approvedA(w);
    w.approvals.startPayment(P, a.s.request.id, a.approvalId);
    const o = result(await w.approvals.createOrder(P, a.s.request.id, a.approvalId));
    mock(w).approve(o.orderId!);
    return { ...a, orderId: o.orderId! };
  }

  const recordOf = (w: World, requestId: string, approvalId: string) => {
    const id = w.approvals.paymentReadiness(P, requestId, approvalId)!.payments[0].recordId;
    return w.payments.getRecord(id)!;
  };

  test("V1 — B's capture never reached PayPal: one capture request in total; A sends nothing; Check stays CAPTURE_UNKNOWN (blocked, not PAID / FAILED)", async () => {
    const w = world();
    const { s, approvalId, orderId } = await orderReady(w);
    const g = gateNextGetOrder(w, "late-read");
    const pA = w.approvals.capture(P, s.request.id, approvalId, orderId);
    await g.atGate;
    mock(w).captureFaults.push("timeout-before-processing");
    const b = result(await w.approvals.capture(P, s.request.id, approvalId, orderId));
    assert.equal(b.code, "CAPTURE_UNKNOWN");
    const requestIdAfterB = recordOf(w, s.request.id, approvalId).captureRequestId;
    assert.ok(requestIdAfterB);
    g.release();
    const a = result(await pA);

    assert.equal(mock(w).calls.capture.length, 1, "A must not send a capture after B's outcome became unknown");
    assert.equal(a.code, "CAPTURE_UNKNOWN");
    assert.match((a as unknown as { message: string }).message, /does not send a capture again/);
    assert.match((a as unknown as { message: string }).message, /Do not pay again/);
    const rec = recordOf(w, s.request.id, approvalId);
    assert.equal(rec.status, "CAPTURE_UNKNOWN", "neither PAID nor FAILED is invented");
    assert.equal(rec.captureRequestId, requestIdAfterB, "the stored PayPal-Request-Id is not reset");

    const check = result(await w.approvals.reconcile(P, s.request.id, approvalId));
    assert.deepEqual([check.code, check.record.status], ["CAPTURE_UNKNOWN", "CAPTURE_UNKNOWN"]);
    assert.equal(mock(w).calls.capture.length, 1, "Check (read-only) sends no capture");
    assert.equal(mock(w).totalCaptures(), 0, "nothing was paid");
    assert.equal(w.approvals.paymentReadiness(P, s.request.id, approvalId)!.payments[0].status, "CAPTURE_UNKNOWN", "payment stays blocked");
  });

  test("V4 — B's capture reached PayPal but both its response and its follow-up read were lost: one capture request; A sends nothing; Check finds the capture → PAID", async () => {
    const w = world();
    const { s, approvalId, orderId } = await orderReady(w);
    const g = gateNextGetOrder(w, "late-response"); // A's snapshot is read before B's capture lands
    const pA = w.approvals.capture(P, s.request.id, approvalId, orderId);
    await g.atGate;
    mock(w).captureFaults.push("timeout-after-processing");
    const capture = mock(w).captureOrder.bind(mock(w));
    mock(w).captureOrder = async (id, requestId) => {
      try {
        return await capture(id, requestId);
      } finally {
        mock(w).getFailures = 1; // B's own verification read fails too
      }
    };
    const b = result(await w.approvals.capture(P, s.request.id, approvalId, orderId));
    assert.equal(b.code, "CAPTURE_UNKNOWN");
    const requestIdAfterB = recordOf(w, s.request.id, approvalId).captureRequestId;
    g.release();
    const a = result(await pA);

    assert.equal(mock(w).calls.capture.length, 1, "A must not send a capture after B's outcome became unknown");
    assert.equal(a.code, "CAPTURE_UNKNOWN");
    const before = recordOf(w, s.request.id, approvalId);
    assert.equal(before.status, "CAPTURE_UNKNOWN", "not marked PAID before PayPal has been read");
    assert.equal(before.captureRequestId, requestIdAfterB);

    const check = result(await w.approvals.reconcile(P, s.request.id, approvalId));
    assert.deepEqual([check.code, check.record.status], ["PAID", "PAID"], "a read-only check records the capture PayPal shows");
    assert.equal(mock(w).calls.capture.length, 1);
    assert.equal(mock(w).totalCaptures(), 1);
  });
});

describe("approval payment: switch, MOCK gateway, MOCK-only route", () => {
  test("switch: off by default; sandbox only on the main database; mock only on another file; anything else refused", () => {
    const main = join(dir, "data", "main.sqlite");
    const copy = join(dir, "copy.sqlite");
    assert.deepEqual(approvalPaymentMode({}, main, main), { mode: "OFF" });
    assert.deepEqual(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "" }, main, main), { mode: "OFF" });
    assert.deepEqual(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "sandbox" }, main, main), { mode: "SANDBOX" });
    assert.equal(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "sandbox" }, copy, main).mode, "REFUSED");
    assert.deepEqual(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "mock" }, copy, main), { mode: "MOCK" });
    assert.equal(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "mock" }, main, main).mode, "REFUSED");
    assert.equal(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "mock" }, main.toUpperCase(), main).mode, "REFUSED", "case-insensitive path match (Windows)");
    assert.equal(approvalPaymentMode({ TRADEPROOF_APPROVAL_PAYMENTS: "live" }, main, main).mode, "REFUSED");
    assert.equal(paymentsEnabledIn({ mode: "REFUSED", reason: "x" }), false);
    assert.equal(paymentLabel({ mode: "MOCK" }).sku, "TP-APPROVAL-MOCK");
    assert.equal(paymentLabel({ mode: "SANDBOX" }).sku, "TP-APPROVAL");
  });

  test("switch off: payment steps 409 with the reason; nothing written", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    const res = await handlePaymentStep(
      new Request(`${URL_BASE}/${s.request.id}/approvals/${approvalId}/payment`, { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }),
      s.request.id,
      approvalId,
      "start",
      w.approvals,
      { enabled: true, auth: testGate(), paymentsEnabled: false, paymentsRefusedReason: "MOCK payments are refused on the main database" },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, "PAYMENTS_NOT_ENABLED");
    assert.match(body.message, /refused on the main database/);
    assert.equal(rows(w.path).records, 0);
  });

  test("file-backed MOCK gateway: state survives a new instance; create / capture idempotent per request id; queued fault gives an unknown outcome", async () => {
    const file = join(dir, `mock-${++counter}.json`);
    const g = new FileMockPayPal(file, MOCK_PAYEE);
    const o = await g.createOrder({ localId: "tp_1", description: "x", amount: { currencyCode: "USD", value: "12.00" } }, "req-1");
    assert.equal((await g.createOrder({ localId: "tp_1", description: "x", amount: { currencyCode: "USD", value: "12.00" } }, "req-1")).id, o.id);
    const g2 = new FileMockPayPal(file, MOCK_PAYEE);
    assert.equal((await g2.getOrder(o.id!)).purchaseUnits[0].payeeMerchantId, MOCK_PAYEE);
    await assert.rejects(g2.captureOrder(o.id!, "cap-1"), /ORDER_NOT_APPROVED|MOCK capture/);
    assert.ok(g2.approve(o.id!));
    const s = g2.read();
    s.captureFaults = ["timeout-after-processing"];
    (g2 as unknown as { write(x: unknown): void }).write(s);
    await assert.rejects(g2.captureOrder(o.id!, "cap-2"), (e: unknown) => e instanceof GatewayError && e.certainty === "uncertain");
    assert.equal(new FileMockPayPal(file, MOCK_PAYEE).totalCaptures(), 1, "captured although the response was lost");
    assert.equal((await g2.captureOrder(o.id!, "cap-2")).status, "COMPLETED", "same request id → same result");
    await assert.rejects(g2.captureOrder(o.id!, "cap-3"), (e: unknown) => e instanceof GatewayError && e.issue === "ORDER_ALREADY_CAPTURED");
    assert.equal(g2.totalCaptures(), 1);
  });

  test("MOCK-only route: 404 without a MOCK gateway; with one it approves only the approval's own order", async () => {
    const w = world();
    const { s, approvalId } = await approvedA(w);
    const req = () => new Request(`${URL_BASE}/${s.request.id}/approvals/${approvalId}/payment/mock-approve`, { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } });
    const approved: string[] = [];
    const fake = { approve: (id: string) => (approved.push(id), true) };
    assert.equal((await handleMockApprove(req(), s.request.id, approvalId, w.approvals, { enabled: true, auth: testGate(), mock: null })).status, 404);
    assert.equal((await handleMockApprove(req(), s.request.id, approvalId, w.approvals, { enabled: true, auth: testGate(), mock: fake })).status, 409, "no order yet");
    w.approvals.startPayment(P, s.request.id, approvalId);
    const o = result(await w.approvals.createOrder(P, s.request.id, approvalId));
    assert.equal((await handleMockApprove(req(), s.request.id, approvalId, w.approvals, { enabled: true, auth: testGate(), mock: fake })).status, 200);
    assert.deepEqual(approved, [o.orderId]);
  });
});
