// Decision summary on the Quotes page (5 Nov): the pure mapper only NAMES what the server decided. "Not checked",
// "blocked", "needs confirmation", "approved" and "paid" stay separate facts; an older version is never shown as
// approved because another version is; the buyer never gets an approve step; nothing is guessed while loading.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decisionView, type DecisionApproval, type DecisionFacts } from "../src/lib/approval-entry.ts";

const approval = (over: Partial<DecisionApproval> = {}): DecisionApproval => ({
  id: "ap_1",
  state: "ACTIVE",
  createdAt: "2026-11-05T08:00:00Z",
  versionNumber: 2,
  versionId: "qv_v2",
  seriesId: "qs_s",
  runId: "qx_r",
  amountMinor: 6800,
  currency: "USD",
  payment: null,
  ...over,
});
const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
  role: "OWNER",
  approverAssigned: true,
  versionNumber: 2,
  latestVersionNumber: 2,
  evaluation: { status: "READY_WITH_CONFIRMATIONS", findings: [{ level: "CONFIRM", code: "KEY_ATTRIBUTE_BY_EYE" }, { level: "INFO", code: "MOCK_RUN" }] },
  approvals: { here: [], otherActive: [] },
  ...over,
});

describe("decision summary mapper", () => {
  test("path A: blocked → counts only BLOCK findings; the buyer is sent to the supplier / request, the approver waits", () => {
    const ev = { status: "BLOCKED" as const, findings: [{ level: "BLOCK" as const, code: "QTY_DIFFERS" }, { level: "BLOCK" as const, code: "TOTAL_DIFFERS_FROM_LINES" }, { level: "INFO" as const, code: "MOCK_RUN" }] };
    const owner = decisionView(facts({ evaluation: ev, approverAssigned: false }));
    assert.deepEqual(owner.check, { kind: "BLOCKED", count: 2 });
    assert.deepEqual(owner.next, { key: "OWNER_BLOCKED", primary: "clarify", secondary: "request" });
    const approver = decisionView(facts({ evaluation: ev, role: "APPROVER", approverAssigned: null }));
    assert.equal(approver.next?.key, "APPROVER_BLOCKED");
    assert.equal(approver.next?.primary, null, "no action offered to the approver on a blocked version");
  });

  test("path B: waiting → the buyer is told who acts, never offered an approve step; the approver gets 'approve'", () => {
    const owner = decisionView(facts());
    assert.deepEqual(owner.check, { kind: "READY_WITH_CONFIRMATIONS", count: 1 });
    assert.equal(owner.approval.kind, "NONE");
    assert.equal(owner.payment.kind, "NONE");
    assert.deepEqual(owner.next, { key: "OWNER_WAITING", primary: null, secondary: null });
    assert.equal(decisionView(facts({ approverAssigned: false })).next?.key, "OWNER_NO_APPROVER");
    const approver = decisionView(facts({ role: "APPROVER", approverAssigned: null }));
    assert.deepEqual(approver.next, { key: "APPROVER_REVIEW", primary: "approve", secondary: null });
    for (const role of ["OWNER", "APPROVER"] as const) {
      for (const status of ["BLOCKED", "READY", "READY_WITH_CONFIRMATIONS"] as const) {
        const d = decisionView(facts({ role, evaluation: { status, findings: [] } }));
        if (role === "OWNER") assert.notEqual(d.next?.primary, "approve", "the owner never gets an approve action");
      }
    }
  });

  test("approved and paid are separate: Active + not paid → pay; Active + PAID → paid; an open payment is neither", () => {
    const active = decisionView(facts({ approvals: { here: [approval()], otherActive: [] } }));
    assert.equal(active.approval.kind, "ACTIVE");
    assert.equal(active.payment.kind, "NONE");
    assert.equal(active.next?.key, "OWNER_PAY");
    const open = decisionView(facts({ approvals: { here: [approval({ payment: { status: "CREATED", sku: "TP-APPROVAL-MOCK", amountMinor: 6800, currency: "USD", paidAt: null } })], otherActive: [] } }));
    assert.deepEqual([open.payment.kind, open.next?.key], ["OPEN", "OWNER_PAY_OPEN"]);
    const paid = decisionView(facts({ evaluation: { status: "BLOCKED", findings: [{ level: "BLOCK", code: "ALREADY_PAID" }] }, approvals: { here: [approval({ payment: { status: "PAID", sku: "TP-APPROVAL-MOCK", amountMinor: 6800, currency: "USD", paidAt: "x" } })], otherActive: [] } }));
    assert.equal(paid.payment.kind, "PAID");
    assert.equal(paid.check.kind, "PAID_NO_NEW_APPROVAL", "only ALREADY_PAID + this version PAID → 'new approval blocked — already paid'");
    assert.equal(paid.approval.kind, "ACTIVE", "the existing approval stays shown");
    // Another blocking reason next to ALREADY_PAID: shown as plain BLOCKED with its count (nothing hidden).
    const paidRow = { status: "PAID", sku: "TP-APPROVAL-MOCK", amountMinor: 6800, currency: "USD", paidAt: "x" };
    const mixed = decisionView(facts({ evaluation: { status: "BLOCKED", findings: [{ level: "BLOCK", code: "ALREADY_PAID" }, { level: "BLOCK", code: "REQUEST_CHANGED_SINCE_QUOTE" }] }, approvals: { here: [approval({ payment: paidRow })], otherActive: [] } }));
    assert.deepEqual(mixed.check, { kind: "BLOCKED", count: 2 });
    // ALREADY_PAID but THIS version is not the paid one (another version paid): plain BLOCKED.
    const elsewhere = decisionView(facts({ versionNumber: 1, evaluation: { status: "BLOCKED", findings: [{ level: "BLOCK", code: "ALREADY_PAID" }] }, approvals: { here: [], otherActive: [approval({ payment: paidRow })] } }));
    assert.deepEqual(elsewhere.check, { kind: "BLOCKED", count: 1 });
    assert.equal(paid.next?.key, "OWNER_PAID");
    const approverDone = decisionView(facts({ role: "APPROVER", approverAssigned: null, approvals: { here: [approval()], otherActive: [] } }));
    assert.equal(approverDone.next?.key, "APPROVER_DONE");
  });

  test("an older version is never shown as approved or paid because another version is", () => {
    const other = approval({ payment: { status: "PAID", sku: "TP-APPROVAL-MOCK", amountMinor: 6800, currency: "USD", paidAt: "x" } });
    const v1 = decisionView(facts({ versionNumber: 1, latestVersionNumber: 2, evaluation: { status: "BLOCKED", findings: [{ level: "BLOCK", code: "NOT_LATEST_VERSION" }] }, approvals: { here: [], otherActive: [other] } }));
    assert.equal(v1.approval.kind, "OTHER");
    assert.deepEqual(v1.approval.kind === "OTHER" ? v1.approval.versions : null, [2]);
    assert.deepEqual(v1.payment, { kind: "OTHER", versions: [2] });
    assert.equal(v1.next?.key, "OWNER_OTHER_ACTIVE");
    // No approval anywhere: the older version leads to the latest one.
    const plain = decisionView(facts({ versionNumber: 1, latestVersionNumber: 2, evaluation: { status: "BLOCKED", findings: [{ level: "BLOCK", code: "NOT_LATEST_VERSION" }] } }));
    assert.deepEqual([plain.approval.kind, plain.next?.key, plain.next?.primary], ["NONE", "OWNER_OLDER", "latest"]);
    // An invalidated approval of this version is not "approved".
    const inv = decisionView(facts({ approvals: { here: [approval({ state: "INVALIDATED" })], otherActive: [] } }));
    assert.equal(inv.approval.kind, "INVALIDATED");
    assert.equal(inv.next?.key, "OWNER_WAITING");
  });

  test("not checked ≠ blocked; nothing is guessed while loading or after a read error", () => {
    const none = decisionView(facts({ evaluation: null }));
    assert.deepEqual([none.check.kind, none.next?.key], ["NOT_CHECKED", "OWNER_NO_RUN"]);
    assert.equal(decisionView(facts({ evaluation: null, role: "APPROVER", approverAssigned: null })).next?.key, "APPROVER_NO_RUN");
    for (const evaluation of ["loading", "error"] as const) assert.equal(decisionView(facts({ evaluation })).next, null);
    for (const approvals of ["loading", "error"] as const) {
      const d = decisionView(facts({ approvals }));
      assert.equal(d.next, null);
      assert.equal(d.payment.kind, "LOADING");
    }
  });
});
