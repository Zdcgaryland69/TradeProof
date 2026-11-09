// Payment display (9 Nov). Two defects seen in the 8 Nov recording on a MOCK copy:
//   1. After a MOCK capture the step result read "PAID: Payment captured and verified against PayPal." The 2 Nov fix
//      (statusHelp.MOCK_PAID) only reworded the status pill line; the step result is the payment SERVICE's own message,
//      which did not know it ran on the simulated gateway. Now the MOCK service says MOCK; the Sandbox wording stays.
//   2. After PAID the Money panel said "This payment to the supplier: Not determined — blocked" (it showed only the
//      fresh preview, which is blocked by ALREADY_PAID). Now it names the payment already made and, separately, whether
//      anything new can be approved or paid; the payee is the fixed Sandbox test merchant, never "the supplier".
// No PayPal request: the gateway is the in-memory MockPayPal stand-in in both branches.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { en } from "../src/i18n/en.ts";
import { moneyPanelView, type MoneyPanelFacts } from "../src/lib/money-panel.ts";
import { mockMessage, PaymentService, type ServiceResult } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { MOCK_PAYEE, MockPayPal } from "./mock-paypal.ts";

const dir = mkdtempSync(join(tmpdir(), "tp-paydisplay-"));
const stores: PaymentStore[] = [];
let n = 0;
after(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function payOnce(simulated: boolean) {
  const store = new PaymentStore(join(dir, `p-${++n}.sqlite`));
  stores.push(store);
  const paypal = new MockPayPal();
  const service = new PaymentService({ store, gateway: paypal, payeeMerchantId: MOCK_PAYEE, simulated });
  const results: ServiceResult[] = [];
  const rec = service.createTestRecord();
  results.push(rec);
  const order = await service.createPayPalOrder(rec.record!.id);
  results.push(order);
  results.push(await service.createPayPalOrder(rec.record!.id)); // existing order reused
  paypal.approve(order.orderId!);
  const cap = await service.capture(rec.record!.id);
  results.push(cap);
  results.push(await service.reconcile(rec.record!.id));
  results.push(await service.capture(rec.record!.id)); // already paid
  return { cap, results, paypal };
}

describe("payment step result wording: MOCK vs Sandbox", () => {
  test("MOCK service: PAID result says MOCK, no PayPal request, never 'verified against PayPal'", async () => {
    const { cap, results } = await payOnce(true);
    assert.equal(cap.code, "PAID");
    assert.equal(cap.record?.status, "PAID");
    assert.match(cap.message, /^MOCK capture recorded/);
    assert.match(cap.message, /No PayPal request was made and no money moved/);
    for (const r of results) {
      assert.doesNotMatch(r.message, /verified against PayPal/i, `${r.code}: ${r.message}`);
      assert.match(r.message, /MOCK/, `${r.code} result does not say MOCK: ${r.message}`);
    }
    assert.match(results[1].message, /MOCK order created/);
    assert.match(results[4].message, /simulated MOCK PayPal: still paid/);
  });

  test("Sandbox branch (not simulated): wording unchanged — the real path still says it was verified against PayPal", async () => {
    const { cap, results } = await payOnce(false);
    assert.equal(cap.code, "PAID");
    assert.equal(cap.message, "Payment captured and verified against PayPal.");
    assert.equal(results[1].message, "PayPal order created.");
    assert.equal(results[4].message, "Re-verified against PayPal: still paid.");
    for (const r of results) assert.doesNotMatch(r.message, /MOCK/);
  });

  test("state machine and amounts are the same in both branches (only the words differ)", async () => {
    const a = await payOnce(true);
    const b = await payOnce(false);
    assert.deepEqual(
      a.results.map((r) => [r.ok, r.code, r.record?.status, r.record?.amountMinor, r.record?.currency]),
      b.results.map((r) => [r.ok, r.code, r.record?.status, r.record?.amountMinor, r.record?.currency]),
    );
  });

  test("any other MOCK message is prefixed so it cannot read as a PayPal result", () => {
    assert.equal(mockMessage("PayPal rejected the capture."), "MOCK (simulated PayPal, no PayPal request): PayPal rejected the capture.");
    assert.doesNotMatch(en.approval.pay.statusHelp.MOCK_PAID, /verified against PayPal/);
  });

  test("the MOCK approval-payment service is built with simulated: true (the app's only MOCK wiring)", () => {
    const src = readFileSync("src/server/approval/index.ts", "utf8");
    assert.match(src, /new FileMockPayPal\([\s\S]*?new PaymentService\(\{[^}]*simulated: true[^}]*\}\)/);
  });
});

const base: MoneyPanelFacts = { proposed: null, approvedHere: null, paidHere: null, paidOther: null, open: null };

describe("Money panel: payment already made vs. what can be done now", () => {
  test("v2 PAID (MOCK): actual amount, PAID, MOCK; nothing new can be approved or paid", () => {
    const v = moneyPanelView({ ...base, paidHere: { amount: "USD 68.00", env: "MOCK" } });
    assert.deepEqual(v.recorded, { kind: "PAID_HERE", amount: "USD 68.00", env: "MOCK" });
    assert.deepEqual(v.next, { kind: "NONE_PAID" });
    assert.equal(en.approval.money.recordedPaid("USD 68.00", "MOCK"), "USD 68.00 · PAID (MOCK)");
  });

  test("v1 of the same request: names v2's payment as another version's, and v1 as not payable", () => {
    const v = moneyPanelView({ ...base, paidOther: { versionNumber: 2, amount: "USD 68.00", env: "MOCK" } });
    assert.equal(v.recorded.kind, "PAID_OTHER");
    assert.deepEqual(v.next, { kind: "NONE_PAID" });
    assert.match(en.approval.money.recordedPaidOther(2, "USD 68.00", "MOCK"), /for quote version 2, not this version/);
  });

  test("before approval / approved / open / blocked", () => {
    assert.deepEqual(moneyPanelView({ ...base, proposed: "USD 68.00" }), { recorded: { kind: "NONE" }, next: { kind: "PROPOSED", amount: "USD 68.00" } });
    assert.deepEqual(moneyPanelView({ ...base, proposed: "USD 68.00", approvedHere: "USD 68.00" }).next, { kind: "APPROVED", amount: "USD 68.00" });
    const open = moneyPanelView({ ...base, approvedHere: "USD 68.00", open: { status: "ORDER_CREATED", amount: "USD 68.00", versionNumber: 2, env: "MOCK" } });
    assert.equal(open.recorded.kind, "OPEN");
    assert.deepEqual(open.next, { kind: "NONE_OPEN", status: "ORDER_CREATED" });
    assert.deepEqual(moneyPanelView(base).next, { kind: "NONE_BLOCKED" });
  });

  test("a paid payment is never shown as 'Not determined'; the payee is never called the supplier", () => {
    const m = en.approval.money as Record<string, unknown>;
    assert.equal(m.thisPayment, undefined);
    assert.equal(m.thisPaymentNone, undefined);
    assert.match(en.approval.money.payeeValue, /test merchant .*not the supplier/);
    const page = readFileSync("src/app/procurements/[id]/quotes/approval/page.tsx", "utf8");
    assert.ok(!page.includes("thisPaymentNone"));
    assert.ok(page.includes("moneyPanelView("));
    const catalogue = readFileSync("src/i18n/en.ts", "utf8");
    assert.ok(!catalogue.includes("This payment to the supplier"));
  });
});

// 9 Nov (second round): labels follow each record's own kind (sku), never the server's current mode.
import { paymentKind, paymentLabels } from "../src/lib/payment-labels.ts";

describe("payment labels by the record's own kind", () => {
  test("MOCK record: MOCK order / MOCK capture / Check MOCK payment status; no 'PayPal' in its labels or help", () => {
    assert.equal(paymentKind("TP-APPROVAL-MOCK"), "MOCK");
    const L = paymentLabels("MOCK");
    assert.equal(L.order, "MOCK order");
    assert.equal(L.capture, "MOCK capture");
    assert.equal(L.reconcile, "Check MOCK payment status (read-only)");
    assert.equal(L.createOrder, "Create MOCK order");
    for (const st of ["NEW", "ORDER_CREATING", "ORDER_CREATED", "CAPTURE_UNKNOWN", "CAPTURE_PENDING", "PAID", "NEEDS_REVIEW", "FAILED"]) {
      const h = L.statusHelp(st);
      assert.ok(h.length > 0, st);
      assert.doesNotMatch(h.replace(/simulated MOCK PayPal|no PayPal request|No PayPal request/g, ""), /PayPal/, `${st}: ${h}`);
    }
  });

  test("Sandbox record keeps the PayPal wording — also when viewed on a MOCK server (kind comes from the sku only)", () => {
    assert.equal(paymentKind("TP-APPROVAL"), "SANDBOX");
    const L = paymentLabels(paymentKind("TP-APPROVAL"));
    assert.deepEqual([L.order, L.capture, L.reconcile, L.createOrder], ["PayPal order", "PayPal capture", "Check with PayPal (read-only)", "Create PayPal order"]);
    assert.equal(L.statusHelp("PAID"), en.approval.pay.statusHelp.PAID);
    assert.match(L.statusHelp("PAID"), /verified against PayPal/);
  });

  test("pages take the kind from the record, not from the server mode", () => {
    const panel = readFileSync("src/app/procurements/[id]/quotes/approval/PaymentPanel.tsx", "utf8");
    assert.match(panel, /paymentLabels\(current \? paymentKind\(current\.sku\)/);
    assert.ok(!panel.includes('mode === "MOCK" && current.status === "PAID"'));
    assert.ok(!/\{t\.reconcile\}|\{t\.createOrder\}/.test(panel));
    const page = readFileSync("src/app/procurements/[id]/quotes/approval/page.tsx", "utf8");
    assert.match(page, /const kind = paymentKind\(x\.sku\)/);
    assert.ok(!/\{p\.facts\.order\}|\{p\.facts\.capture\}/.test(page));
    assert.ok(!page.includes("qe.payEnv[payMode.mode] : t.money.envLabel"), "open record env must come from its sku");
  });
});

describe("conditions sheet without a payable amount names the version", () => {
  test("v1 blocked while v2 is paid: 'No payable amount for version 1', blocked reason pointer, v2 named without its amount", () => {
    assert.equal(en.approval.sheet.amountNoneVersion(1), "No payable amount for version 1");
    assert.match(en.approval.sheet.amountNoneBlocked, /Blocking/);
    const other = en.approval.sheet.amountNonePaidOther(2);
    assert.match(other, /belongs to version 2, not to this version/);
    assert.doesNotMatch(other, /\d+\.\d\d/, "no amount of another version on this version's sheet");
    const page = readFileSync("src/app/procurements/[id]/quotes/approval/page.tsx", "utf8");
    assert.ok(!page.includes("t.sheet.amountNone}"), "bare 'Not determined' no longer used");
    assert.equal((en.approval.sheet as Record<string, unknown>).amountNone, undefined);
  });
});

// 9 Nov (later): the Money panel heading follows the record status. "Payment already made" was shown above an
// ORDER_CREATED record in the t2 video ("Payment already made: USD 68.00 · ORDER_CREATED — outcome still open"); an
// order that exists is not a payment. Only PAID (or "None") uses "Payment already made". Display only.
import { recordedHeading } from "../src/lib/money-panel.ts";
import { RECORD_STATUSES } from "../src/server/payments/types.ts";

describe("Money panel heading per payment status", () => {
  const m = en.approval.money;
  const openOf = (status: string, env: "MOCK" | "Sandbox" = "MOCK") =>
    moneyPanelView({ ...base, approvedHere: "USD 68.00", open: { status, amount: "USD 68.00", versionNumber: 2, env } });
  const line = (v: ReturnType<typeof moneyPanelView>) => {
    const r = v.recorded;
    const text = r.kind === "OPEN" ? m.recordedOpen(r.status, r.amount, r.versionNumber) : r.kind === "FAILED" ? m.recordedFailed(r.amount, r.versionNumber) : r.kind === "PAID_HERE" ? m.recordedPaid(r.amount, r.env) : r.kind === "PAID_OTHER" ? m.recordedPaidOther(r.versionNumber, r.amount, r.env) : m.recordedNone;
    return `${m.heading[recordedHeading(r)]}: ${text}`;
  };
  const expected: Record<string, string> = {
    NEW: "Payment in progress",
    ORDER_CREATING: "Payment in progress",
    ORDER_CREATED: "Payment in progress",
    CAPTURING: "Payment in progress",
    CAPTURE_UNKNOWN: "Payment outcome unknown",
    CAPTURE_PENDING: "Payment pending",
    NEEDS_REVIEW: "Payment needs review",
  };

  test("every open status (all RECORD_STATUSES except PAID / FAILED) has its own heading and note, never 'already made'", () => {
    const open = RECORD_STATUSES.filter((st) => st !== "PAID" && st !== "FAILED");
    assert.deepEqual([...open].sort(), Object.keys(expected).sort(), "a new record status needs a Money heading");
    for (const st of open) {
      for (const env of ["MOCK", "Sandbox"] as const) {
        const v = openOf(st, env);
        assert.equal(v.recorded.kind, "OPEN");
        const l = line(v);
        assert.ok(l.startsWith(`${expected[st]}: USD 68.00 · ${st} — `), l);
        assert.ok(!/already made/i.test(l), l);
        assert.ok(!/outcome still open/.test(l), l);
        assert.ok(m.openNote[st], `note for ${st}`);
        assert.match(l, /not paid|not confirmed as paid/, l);
        assert.ok(l.endsWith("(quote version 2)"), l);
        assert.deepEqual(v.next, { kind: "NONE_OPEN", status: st }); // what can be done now: unchanged
      }
    }
  });

  test("the t2 video case: ORDER_CREATED reads 'Payment in progress … not paid yet'", () => {
    assert.equal(line(openOf("ORDER_CREATED")), "Payment in progress: USD 68.00 · ORDER_CREATED — order created, not captured — not paid yet (quote version 2)");
  });

  test("only PAID (or no record) uses 'Payment already made'", () => {
    assert.equal(line(moneyPanelView({ ...base, paidHere: { amount: "USD 68.00", env: "MOCK" } })), "Payment already made: USD 68.00 · PAID (MOCK)");
    assert.equal(line(moneyPanelView({ ...base, paidHere: { amount: "USD 12.00", env: "Sandbox" } })), "Payment already made: USD 12.00 · PAID (Sandbox)");
    assert.equal(line(moneyPanelView({ ...base, paidOther: { versionNumber: 2, amount: "USD 68.00", env: "MOCK" } })), "Payment already made: USD 68.00 · PAID (MOCK) — for quote version 2, not this version");
    assert.equal(line(moneyPanelView({ ...base, proposed: "USD 68.00" })), "Payment already made: None for this request.");
  });

  test("FAILED is named as a rejected attempt, not paid; it does not block a new payment (rules unchanged)", () => {
    const v = moneyPanelView({ ...base, approvedHere: "USD 68.00", failed: { amount: "USD 68.00", versionNumber: 2, env: "MOCK" } });
    assert.equal(v.recorded.kind, "FAILED");
    assert.equal(line(v), "Last payment attempt: USD 68.00 · FAILED — the step was rejected; not paid (quote version 2)");
    assert.deepEqual(v.next, { kind: "APPROVED", amount: "USD 68.00" });
  });

  test("precedence: PAID over open over FAILED; an unknown status name is never shown as paid", () => {
    const paid = { amount: "USD 68.00", env: "MOCK" as const };
    const open = { status: "ORDER_CREATED", amount: "USD 68.00", versionNumber: 2, env: "MOCK" as const };
    const failed = { amount: "USD 68.00", versionNumber: 2, env: "MOCK" as const };
    assert.equal(moneyPanelView({ ...base, paidHere: paid, open, failed }).recorded.kind, "PAID_HERE");
    assert.equal(moneyPanelView({ ...base, open, failed }).recorded.kind, "OPEN");
    assert.equal(line(openOf("SOMETHING_NEW")), "Payment status: USD 68.00 · SOMETHING_NEW — not confirmed as paid (quote version 2)");
  });

  test("page uses the per-status heading; MOCK / Sandbox environment labels kept", () => {
    const page = readFileSync("src/app/procurements/[id]/quotes/approval/page.tsx", "utf8");
    assert.ok(page.includes("t.money.heading[recordedHeading(r)]"));
    assert.ok(!page.includes("recordedLabel"));
    assert.ok(page.includes('p.status === "FAILED"'));
    assert.match(m.envLabel.MOCK, /^MOCK — simulated PayPal; no PayPal request, no money moved$/);
    assert.match(m.envLabel.Sandbox, /^PayPal Sandbox — test money only$/);
    assert.equal((m as Record<string, unknown>).recordedLabel, undefined);
  });
});
