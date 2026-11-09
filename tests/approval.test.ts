// Approval condition snapshot and version binding (29 Oct, schema v14). Temporary databases only; SYNTHETIC cases
// (tests/helpers/approval-fixtures.ts) replayed through a MOCK test double — no model, no token count, no budget —
// and the MOCK PayPal gateway (tests/mock-paypal.ts) — no network, no real Sandbox.
//
// One test (or more) per requirement: allowed approval; missing conditions; over budget; key differences; corrections
// without evidence; stale preview; repeated and concurrent approval; edit-then-revert; revoke; invalid approvals cannot
// pay; unknown payment outcomes keep their real state; latest version only; statements and linked updated quotes;
// free-text requirement classification; lead time with a deadline; fees outside this payment; determinism; migration.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { recordToInput, type ProcurementInput } from "../src/lib/procurement.ts";
import { evaluateApproval, canonicalJson, requestFingerprint, SANDBOX_CEILING_MINOR, type Evaluation } from "../src/server/approval/evaluate.ts";
import { handleApprove, handlePreview, handlePaymentStep } from "../src/server/approval/http.ts";
import { ApprovalService } from "../src/server/approval/service.ts";
import { ApprovalStore } from "../src/server/approval/store.ts";
import { canApproveRequest, canPayRequest } from "../src/server/access/policy.ts";
import { ClarificationService } from "../src/server/clarification/service.ts";
import { ClarificationStore } from "../src/server/clarification/store.ts";
import { ComparisonService } from "../src/server/comparison/service.ts";
import { SCHEMA_VERSION } from "../src/server/db/database.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { ReplyService } from "../src/server/replies/service.ts";
import { ReplyStore } from "../src/server/replies/store.ts";
import { A, caseText, P, replayModel, replayService, reviewAll, seedCase, type CaseName, type Seeded } from "./helpers/approval-fixtures.ts";
import { MOCK_PAYEE, MockPayPal } from "./mock-paypal.ts";
import { testGate } from "./helpers/principals.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-approval-test-"));
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

function world(path = join(dir, `approval-${++counter}.sqlite`)) {
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
  const replies = new ReplyService(rs, cs);
  const paypal = new MockPayPal();
  const payments = new PaymentService({ store: pay, gateway: paypal, payeeMerchantId: MOCK_PAYEE });
  const payee = { configured: true, merchantId: MOCK_PAYEE as string | null };
  const clock = { now: new Date("2026-10-29T03:00:00Z") };
  const approvals = new ApprovalService({ store: aps, extraction: es, procurement: ps, replies, replyStore: rs, drafts: cs, payments: () => payments, payee: () => payee, now: () => clock.now });
  const clar = new ClarificationService(cs, new ComparisonService(es, { now: () => clock.now }));
  return { path, ps, qs, es, cs, rs, aps, pay, model, svc, replies, paypal, payments, payee, clock, approvals, clar };
}
type World = ReturnType<typeof world>;

const ids = (s: Seeded, runId = s.run.id, versionId = s.versionId) => ({ seriesId: s.seriesId, versionId, runId, baseRunId: null });

function preview(w: World, s: Seeded, runId?: string, versionId?: string): Evaluation {
  const p = w.approvals.preview(P, s.request.id, ids(s, runId, versionId));
  assert.equal(p.status, "OK");
  return (p as { evaluation: Evaluation }).evaluation;
}

const codes = (e: Evaluation, level?: string) => e.findings.filter((f) => !level || f.level === level).map((f) => f.code);

function approve(w: World, s: Seeded, e: Evaluation, key = randomUUID(), extra: Record<string, unknown> = {}, runId?: string, versionId?: string) {
  return w.approvals.approve(A, s.request.id, { ...ids(s, runId, versionId), previewDigest: e.digest, confirmed: e.confirmKeys, ...extra }, key);
}

async function ready(w: World, name: CaseName = "A", opts: Parameters<typeof seedCase>[3] = {}) {
  const s = await seedCase(w, name, `${name} ${counter}`, opts);
  reviewAll(w, s);
  return s;
}

function editRequest(w: World, id: string, change: (i: ProcurementInput) => void) {
  const r = w.ps.get(id)!;
  const input = recordToInput(r);
  change(input);
  const v = validateProcurementInput(input, "update");
  assert.ok(v.ok, JSON.stringify(v));
  const out = w.ps.update(id, r.revision, v.value);
  assert.equal(out.status, "UPDATED");
}

async function approved(w: World, name: CaseName = "A") {
  const s = await ready(w, name);
  const e = preview(w, s);
  assert.notEqual(e.status, "BLOCKED", JSON.stringify(codes(e, "BLOCK")));
  const out = approve(w, s, e);
  assert.equal(out.status, "CREATED", JSON.stringify(out));
  return { s, e, approval: (out as { approval: { id: string } }).approval };
}

const counts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (t: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
    return { approvals: n("approvals"), events: n("approval_events"), payments: n("sandbox_payment_records"), links: n("approval_payments") };
  } finally {
    db.close();
  }
};

describe("approval gate (SYNTHETIC cases)", () => {
  test("A: complete and reviewed → READY; this payment = stated total; landed cost not calculated; no model or PayPal call", async () => {
    const w = world();
    const s = await ready(w, "A");
    const e = preview(w, s);
    assert.equal(e.status, "READY", JSON.stringify(e.findings.filter((f) => f.level !== "INFO")));
    assert.deepEqual(e.amount, { minor: 1200, currency: "USD" });
    assert.equal(e.snapshot.money.thisPayment?.display, "USD 12.00");
    assert.equal(e.snapshot.money.goodsSubtotal, "USD 12.00");
    assert.equal(e.snapshot.money.included.length, 1);
    assert.equal(e.snapshot.money.landedCost, "NOT_CALCULATED_IN_THIS_VERSION");
    assert.ok(codes(e, "INFO").includes("MOCK_RUN") && codes(e, "INFO").includes("PAYEE_IS_SANDBOX_TEST_MERCHANT") && codes(e, "INFO").includes("NOT_A_PAYMENT_AUTHORISATION"));
    assert.equal(e.snapshot.payee.kind, "FIXED_SANDBOX_TEST_MERCHANT");
    assert.equal(w.model.calls, 1, "one MOCK replay for the seeded run only");
    assert.equal(w.paypal.calls.create.length + w.paypal.calls.get.length + w.paypal.calls.capture.length, 0);
  });

  test("B: quantity differs and lines do not add up to the total → BLOCKED with both reasons; nothing stored", async () => {
    const w = world();
    const s = await ready(w, "B");
    const e = preview(w, s);
    assert.equal(e.status, "BLOCKED");
    assert.ok(codes(e, "BLOCK").includes("QTY_DIFFERS"));
    assert.ok(codes(e, "BLOCK").includes("TOTAL_DIFFERS_FROM_LINES"));
    assert.equal(e.amount, null);
    const out = approve(w, s, e);
    assert.equal(out.status, "BLOCKED");
    assert.equal(counts(w.path).approvals, 0);
  });

  test("original 30 % deposit sample (unchanged) → STAGED_PAYMENT blocks", async () => {
    const w = world();
    const s = await ready(w, "DEPOSIT");
    const e = preview(w, s);
    assert.equal(e.status, "BLOCKED");
    assert.ok(codes(e, "BLOCK").includes("STAGED_PAYMENT"), JSON.stringify(codes(e, "BLOCK")));
  });

  test("missing conditions: unreviewed critical values block; a key attribute without supplier basis blocks and offers no confirmation", async () => {
    const w = world();
    const s = await seedCase(w, "A", "unreviewed");
    reviewAll(w, s, { skip: (p) => p === "total" || p === "items[1].unitPrice" });
    const e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("TOTAL_NOT_REVIEWED"));
    assert.ok(codes(e, "BLOCK").includes("PRICE_NOT_REVIEWED"));

    const w2 = world();
    const noGrade = caseText("A").replace("304 stainless steel", "stainless steel");
    const s2 = await seedCase(w2, "A", "no grade", {
      text: noGrade,
      output: (raw) => {
        const o = JSON.parse(raw);
        o.items[0].material = { value: null, quote: null };
        return JSON.stringify(o);
      },
    });
    reviewAll(w2, s2);
    const e2 = preview(w2, s2);
    const f = e2.findings.find((x) => x.code === "KEY_ATTRIBUTE_NOT_QUOTED")!;
    assert.equal(f.level, "BLOCK");
    assert.ok(!e2.confirmKeys.some((k) => k.startsWith("KEY_ATTRIBUTE")), "no tick can pass a missing key attribute");
    // Sending its key as a "confirmation" changes nothing.
    assert.equal(approve(w2, s2, e2, randomUUID(), { confirmed: [f.key] }).status, "BLOCKED");
  });

  test("over budget blocks (owner decision 29 Oct); raising the budget makes the quote's request snapshot stale → re-save needed", async () => {
    const w = world();
    const s = await ready(w, "A", { request: { budgetMax: "10.00" } });
    const e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("OVER_BUDGET"));
    editRequest(w, s.request.id, (i) => (i.budgetMax = "20.00"));
    const e2 = preview(w, s);
    assert.ok(codes(e2, "BLOCK").includes("REQUEST_CHANGED_SINCE_QUOTE"), "the old quote version keeps its own snapshot; it is never swapped");
  });

  test("key difference: required 316, quoted 304 → KEY_ATTRIBUTE_DIFFERS", async () => {
    const w = world();
    const s = await ready(w, "A", {
      request: {
        items: [
          { id: null, name: "Insulated tumbler 500 ml", quantity: "20", unit: "pcs", material: "316 stainless steel", specification: "", customization: "", notes: "" },
          { id: null, name: "Gift box", quantity: "20", unit: "pcs", material: "", specification: "", customization: "", notes: "" },
        ],
      },
    });
    assert.ok(codes(preview(w, s), "BLOCK").includes("KEY_ATTRIBUTE_DIFFERS"));
  });

  test("corrections: without quote evidence they block; a correction that the located excerpt supports is a confirmation", async () => {
    const w = world();
    const s = await seedCase(w, "A", "bad correction");
    reviewAll(w, s, { corrections: { total: "USD 11.00" } });
    const e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("CORRECTION_WITHOUT_EVIDENCE"), JSON.stringify(codes(e, "BLOCK")));

    const w2 = world();
    // The model misread the price (0.54); the excerpt "USD 0.45" was located, so the value check fails.
    const s2 = await seedCase(w2, "A", "misread", {
      output: (raw) => {
        const o = JSON.parse(raw);
        o.items[0].unitPrice = { amount: "0.54", currency: "USD", quote: "USD 0.45" };
        return JSON.stringify(o);
      },
    });
    reviewAll(w2, s2, { corrections: { "items[0].unitPrice": "USD 0.45" } });
    const e2 = preview(w2, s2);
    assert.ok(!codes(e2, "BLOCK").includes("CORRECTION_WITHOUT_EVIDENCE"), JSON.stringify(codes(e2, "BLOCK")));
    assert.ok(codes(e2, "CONFIRM").includes("USES_CORRECTION"));
    assert.equal(e2.status, "READY_WITH_CONFIRMATIONS", JSON.stringify(codes(e2, "BLOCK")));
    // Confirmations must be exactly the preview's keys.
    assert.equal(approve(w2, s2, e2, randomUUID(), { confirmed: [] }).status, "CONFIRMATIONS_MISMATCH");
    assert.equal(approve(w2, s2, e2).status, "CREATED");
  });

  test("lead time with a deadline: 'after receipt of payment' cannot be verified against the date → blocks", async () => {
    const w = world();
    const s = await ready(w, "A", { request: { requiredShipDate: "2026-12-15" } });
    const e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("LEAD_TIME_UNVERIFIABLE"), JSON.stringify(codes(e, "BLOCK")));
  });

  test("C: duties outside this payment (unknown) and an estimated forwarder fee (unverified) → allowed only with confirmation", async () => {
    const w = world();
    const s = await ready(w, "C");
    const e = preview(w, s);
    assert.equal(e.status, "READY_WITH_CONFIRMATIONS", JSON.stringify(codes(e, "BLOCK")));
    assert.equal(e.snapshot.money.thisPayment?.display, "USD 12.00");
    assert.equal(e.snapshot.money.unknown.length, 1);
    assert.equal(e.snapshot.money.unverified.length, 1);
    assert.equal(e.snapshot.money.excluded.length, 0);
    assert.equal(e.findings.filter((f) => f.code === "OUTSIDE_THIS_PAYMENT").length, 2);
    assert.equal(approve(w, s, e, randomUUID(), { confirmed: [] }).status, "CONFIRMATIONS_MISMATCH");
    assert.equal(approve(w, s, e).status, "CREATED");
  });

  test("a supplier-payable fee outside the total blocks", async () => {
    const w = world();
    const text = `${caseText("A")}Mould fee: to be confirmed, not included, payable to us\n`;
    const line = "Mould fee: to be confirmed, not included, payable to us";
    const s = await seedCase(w, "A", "mould", {
      text,
      output: (raw) => {
        const o = JSON.parse(raw);
        const f = (value: string | null) => (value === null ? { value: null, quote: null } : { value, quote: line });
        o.fees.push({ kind: f("OTHER"), description: f("Mould fee"), amount: { amount: null, currency: null, quote: null }, amountBasis: f(null), payer: f(null), payee: f("SUPPLIER"), includedInQuote: f("NOT_INCLUDED"), statedAs: f("TO_BE_CONFIRMED") });
        return JSON.stringify(o);
      },
    });
    reviewAll(w, s);
    assert.ok(codes(preview(w, s), "BLOCK").includes("SUPPLIER_EXTRA_OUTSIDE_TOTAL"));
  });

  test("only the latest version of the series is approvable; no confirmation unlocks an older one", async () => {
    const w = world();
    const s = await ready(w, "A");
    const v2 = w.qs.addVersion(s.request.id, s.seriesId, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: w.ps.get(s.request.id)!.revision,
      expectedLatestVersionId: s.versionId,
      version: { rawText: caseText("A"), contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "v2", supplierQuoteDate: null, revisionNote: null },
    });
    assert.equal(v2.status, "CREATED");
    const e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("NOT_LATEST_VERSION"));
    assert.ok(!e.confirmKeys.some((k) => k.startsWith("NOT_LATEST")));
  });

  test("free-text requirements must be classified with a reason; KEY_IN_QUOTE needs a verbatim excerpt from the quote", async () => {
    const w = world();
    const s = await ready(w, "A", {
      request: {
        items: [
          { id: null, name: "Insulated tumbler 500 ml", quantity: "20", unit: "pcs", material: "304 stainless steel", specification: "", customization: "", notes: "Packed in gift box" },
          { id: null, name: "Gift box", quantity: "20", unit: "pcs", material: "", specification: "", customization: "", notes: "" },
        ],
        additionalRequirements: "Food-contact test report required",
      },
    });
    let e = preview(w, s);
    assert.equal(e.findings.filter((f) => f.code === "REQUIREMENT_NOT_CLASSIFIED").length, 2);
    const note = `ITEM_NOTES:${s.lines.tumbler}`;
    const cls = (body: Record<string, unknown>) => w.approvals.classify(P, s.request.id, s.seriesId, s.versionId, body, randomUUID());
    assert.equal(cls({ subject: note, decision: "NOT_KEY", reason: "" }).status, "INVALID", "a reason is required");
    assert.equal(cls({ subject: note, decision: "KEY_IN_QUOTE", reason: "packaging", excerpt: "gift box with foam insert" }).status, "INVALID", "excerpt must be in the quote");
    assert.equal(cls({ subject: note, decision: "KEY_IN_QUOTE", reason: "packaging is part of the order", excerpt: "2. Gift box: 20 pcs" }).status, "CREATED");
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_NOT_IN_QUOTE", reason: "the quote says nothing about a test report" }).status, "CREATED");
    e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("KEY_REQUIREMENT_NOT_QUOTED"));
    assert.ok(codes(e, "INFO").includes("KEY_REQUIREMENT_IN_QUOTE"));
    // 7 Nov: a re-classification names the classification it replaces.
    const current = w.aps.classifications(s.versionId).find((c) => c.subject === "ADDITIONAL_REQUIREMENTS")!;
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "report will be requested separately, not a condition of this order", replaces: current.id }).status, "CREATED");
    e = preview(w, s);
    assert.equal(e.status, "READY", JSON.stringify(codes(e, "BLOCK")));
  });

  test("re-classification (7 Nov): must name the current row; stale or blind saves store nothing; identical re-save adds no row; history kept; an Active approval becomes no longer valid", async () => {
    const w = world();
    const s = await ready(w, "A", { request: { additionalRequirements: "Sample order for a quality check" } });
    const key = () => randomUUID();
    const cls = (body: Record<string, unknown>, k = key()) => w.approvals.classify(P, s.request.id, s.seriesId, s.versionId, body, k);
    const rows = () => ({ n: w.aps.classificationHistory(s.versionId).length });
    // First classification: nothing to replace; naming a row is refused.
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "x", replaces: `rc_${randomUUID()}` }).status, "STALE");
    const k1 = key();
    const first = cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "mis-selected" }, k1) as { status: string; classification: { id: string } };
    assert.equal(first.status, "CREATED");
    // Replay of the first save (same key, same body) still replays after the rule exists.
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "mis-selected" }, k1).status, "REPLAYED");
    // Blind re-classification (no `replaces`) and a malformed id are refused; nothing stored.
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_NOT_IN_QUOTE", reason: "blind" }).status, "STALE");
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_NOT_IN_QUOTE", reason: "bad", replaces: "nope" }).status, "INVALID");
    assert.equal(rows().n, 1);
    // Identical content naming the current row: UNCHANGED, no row.
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "mis-selected", replaces: first.classification.id }).status, "UNCHANGED");
    assert.equal(rows().n, 1);
    // Approve on the first classification, then correct it: new row, old row kept, approval no longer valid.
    const approved = approve(w, s, preview(w, s));
    assert.equal(approved.status, "CREATED", JSON.stringify(approved).slice(0, 300));
    const fix = cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_NOT_IN_QUOTE", reason: "the quote does not state the sample-order purpose", replaces: first.classification.id }) as { status: string; classification: { id: string } };
    assert.equal(fix.status, "CREATED");
    assert.equal(rows().n, 2, "append-only: the mis-selection stays in the history");
    // A second tab still holding the first row cannot overwrite the correction.
    assert.equal(cls({ subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "stale tab", replaces: first.classification.id }).status, "STALE");
    assert.equal(rows().n, 2);
    assert.equal(w.aps.classifications(s.versionId).find((c) => c.subject === "ADDITIONAL_REQUIREMENTS")!.id, fix.classification.id, "latest row wins");
    const v = w.approvals.view(P, s.request.id, (approved as { approval: { id: string } }).approval.id)!;
    assert.equal(v.validity.state, "INVALIDATED");
    assert.ok(v.validity.reasons.some((r) => r.startsWith("CLASSIFICATIONS_CHANGED")), v.validity.reasons.join(","));
  });

  test("determinism: the same stored data gives the same digest across calls and service instances; any reviewed value changes it", async () => {
    const w = world();
    const s = await ready(w, "C");
    const a = preview(w, s);
    const b = preview(w, s);
    // 3 Nov: these extra stores are registered for closing (they were left open until GC, holding the temp folder).
    const [os, oe, op] = [new ApprovalStore(w.path), new ExtractionStore(w.path), new ProcurementStore(w.path)];
    open.push(os, oe, op);
    const other = new ApprovalService({ store: os, extraction: oe, procurement: op, replies: w.replies, replyStore: w.rs, drafts: w.cs, payments: () => w.payments, payee: () => w.payee, now: () => w.clock.now });
    const c = other.preview(P, s.request.id, ids(s));
    assert.equal(a.digest, b.digest);
    assert.equal(a.digest, (c as { evaluation: Evaluation }).evaluation.digest);
    assert.deepEqual(a.confirmKeys, b.confirmKeys);
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    // A new review of the same value is a new record: the digest changes.
    w.svc.review(P, s.request.id, s.seriesId, s.versionId, s.run.id, { idempotencyKey: randomUUID(), fieldPath: "total", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: w.es.reviews(s.run.id).filter((r) => r.fieldPath === "total").at(-1)!.id });
    assert.notEqual(preview(w, s).digest, a.digest);
  });

  test("ceiling is a technical limit: a SYNTHETIC total above USD 100.00 blocks (never scaled down)", async () => {
    const w = world();
    const s = await ready(w, "A");
    const input = w.approvals as unknown as { gather: (p: unknown, r: string, i: unknown) => Parameters<typeof evaluateApproval>[0] };
    const e = evaluateApproval({ ...input.gather(P, s.request.id, ids(s)), ceilingMinor: 1000 });
    assert.ok(codes(e, "BLOCK").includes("ABOVE_SANDBOX_CEILING"));
    assert.equal(SANDBOX_CEILING_MINOR, 10_000);
  });
});

describe("approve: re-checked and saved atomically", () => {
  test("stale preview → BASIS_CHANGED, nothing stored", async () => {
    const w = world();
    const s = await ready(w, "A");
    const e = preview(w, s);
    editRequest(w, s.request.id, (i) => (i.title = `${i.title} renamed`));
    // A title change alone does not change the terms, but it is shown (INFO) — so the digest the user saw is stale.
    const out = approve(w, s, e);
    assert.equal(out.status, "BASIS_CHANGED");
    assert.equal(counts(w.path).approvals, 0);
    const fresh = preview(w, s);
    assert.ok(codes(fresh, "INFO").includes("REQUEST_TITLE_ONLY"));
    assert.equal(approve(w, s, fresh).status, "CREATED");
  });

  test("repeated approval: same key → REPLAYED; same key + other payload → KEY_REUSED; new key, same basis → EXISTING; one row", async () => {
    const w = world();
    const s = await ready(w, "A");
    const e = preview(w, s);
    const key = randomUUID();
    assert.equal(approve(w, s, e, key).status, "CREATED");
    assert.equal(approve(w, s, e, key).status, "REPLAYED");
    assert.equal(approve(w, s, e, key, { confirmed: ["X:1"] }).status, "KEY_REUSED");
    assert.equal(approve(w, s, e).status, "EXISTING");
    assert.equal(counts(w.path).approvals, 1);
  });

  test("concurrent approval: a second connection approving the same basis gets the first row; a held write lock makes approve wait / fail, never write twice", async () => {
    const w = world();
    const s = await ready(w, "A");
    const e = preview(w, s);
    const secondStore = new ApprovalStore(w.path, { busyTimeoutMs: 50 });
    open.push(secondStore); // 3 Nov: closed in after() like every other store
    const second = new ApprovalService({ store: secondStore, extraction: w.es, procurement: w.ps, replies: w.replies, replyStore: w.rs, drafts: w.cs, payments: () => w.payments, payee: () => w.payee, now: () => w.clock.now });
    const lock = new DatabaseSync(w.path);
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE");
    assert.throws(() => second.approve(A, s.request.id, { ...ids(s), previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID()), /locked|busy/i);
    lock.exec("ROLLBACK");
    lock.close();
    assert.equal(approve(w, s, e).status, "CREATED");
    assert.equal(second.approve(A, s.request.id, { ...ids(s), previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID()).status, "EXISTING");
    assert.equal(counts(w.path).approvals, 1);
  });

  test("the browser cannot set amount, currency or payee", async () => {
    const w = world();
    const s = await ready(w, "A");
    const e = preview(w, s);
    for (const extra of [{ amount: 1 }, { currency: "EUR" }, { payee: "X" }, { snapshot: {} }]) {
      const out = approve(w, s, e, randomUUID(), extra);
      assert.equal(out.status, "INVALID");
    }
    assert.equal(counts(w.path).approvals, 0);
  });

  test("an approval row is immutable and cannot be deleted", async () => {
    const w = world();
    const { approval } = await approved(w);
    const db = new DatabaseSync(w.path);
    assert.throws(() => db.prepare("UPDATE approvals SET amount_minor = 1 WHERE id = ?").run(approval.id), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM approvals WHERE id = ?").run(approval.id), /cannot be deleted/);
    db.close();
  });
});

describe("validity after approval", () => {
  test("edit then revert: still INVALIDATED (revision records stay); the title alone does not invalidate", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    editRequest(w, s.request.id, (i) => (i.title = `${i.title} (renamed)`));
    assert.equal(w.approvals.view(P, s.request.id, approval.id)!.validity.state, "ACTIVE");
    editRequest(w, s.request.id, (i) => (i.items[0].quantity = "21"));
    editRequest(w, s.request.id, (i) => (i.items[0].quantity = "20"));
    const v = w.approvals.view(P, s.request.id, approval.id)!;
    assert.equal(v.validity.state, "INVALIDATED");
    assert.ok(v.validity.reasons.some((r) => r.startsWith("REQUEST_REVISED")));
    assert.equal(w.approvals.startPayment(P, s.request.id, approval.id).status, "APPROVAL_INVALID");
    assert.equal(counts(w.path).payments, 0);
  });

  test("new review, newer quote version, payee change each invalidate; an unrelated reply without a reading does not", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    const saved = w.replies.saveReply(P, s.request.id, s.seriesId, { rawText: "[SYNTHETIC] Thanks, noted.", source: "TEST_FIXTURE" }, randomUUID());
    assert.equal(saved.status, "CREATED");
    assert.equal(w.approvals.view(P, s.request.id, approval.id)!.validity.state, "ACTIVE", "an ordinary reply does not change the basis");
    w.svc.review(P, s.request.id, s.seriesId, s.versionId, s.run.id, { idempotencyKey: randomUUID(), fieldPath: "total", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: w.es.reviews(s.run.id).filter((r) => r.fieldPath === "total").at(-1)!.id });
    assert.deepEqual(w.approvals.view(P, s.request.id, approval.id)!.validity.reasons, ["REVIEWS_CHANGED"]);

    const w2 = world();
    const a2 = await approved(w2);
    w2.payee.merchantId = "OTHERPAYEE01";
    assert.ok(w2.approvals.view(P, a2.s.request.id, a2.approval.id)!.validity.reasons.includes("PAYEE_CHANGED"));
  });

  test("revoke: reason required; REVOKED is terminal; payment refused", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    assert.equal(w.approvals.revoke(P, s.request.id, approval.id, "", randomUUID()).status, "INVALID");
    const key = randomUUID();
    assert.equal(w.approvals.revoke(P, s.request.id, approval.id, "supplier withdrew the offer (test)", key).status, "REVOKED");
    assert.equal(w.approvals.revoke(P, s.request.id, approval.id, "again", randomUUID()).status, "ALREADY_ENDED");
    assert.equal(w.approvals.view(P, s.request.id, approval.id)!.validity.state, "REVOKED");
    assert.equal(w.approvals.startPayment(P, s.request.id, approval.id).status, "APPROVAL_INVALID");
  });
});

describe("statements and linked updated quotes", () => {
  async function withStatement(w: World) {
    // Request wants 316, the quote says 304: a difference → a question on the draft → the supplier offers 316.
    const s = await ready(w, "A", {
      request: {
        items: [
          { id: null, name: "Insulated tumbler 500 ml", quantity: "20", unit: "pcs", material: "316 stainless steel", specification: "", customization: "", notes: "" },
          { id: null, name: "Gift box", quantity: "20", unit: "pcs", material: "", specification: "", customization: "", notes: "" },
        ],
      },
    });
    const d = w.clar.create(P, s.request.id, s.seriesId, s.versionId, s.run.id, null, null);
    assert.equal(d.status, "CREATED");
    const draft = (d as { draft: { id: string; generated: { questions: { id: string; field: string }[] } } }).draft;
    const q = draft.generated.questions.find((x) => x.field === "material")!;
    const reply = w.replies.saveReply(P, s.request.id, s.seriesId, { rawText: "[SYNTHETIC] We can supply 316 stainless steel at the same price.", source: "TEST_FIXTURE" }, randomUUID());
    assert.ok(reply.status === "CREATED");
    const link = w.replies.linkToDraft(P, s.request.id, draft.id, reply.reply.id, 1, null, randomUUID());
    assert.ok(link.status === "CREATED");
    const ans = w.replies.answer(P, s.request.id, draft.id, link.link.id, q.id, null, { status: "ANSWERED", excerpt: "We can supply 316 stainless steel", buyerStatement: "Supplier offers 316", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.equal(ans.status, "SAVED", JSON.stringify(ans));
    return { s, replyId: reply.reply.id };
  }

  test("a new condition without a linked updated quote blocks; a number in the reply never becomes a value", async () => {
    const w = world();
    const { s } = await withStatement(w);
    const e = preview(w, s);
    assert.ok(codes(e, "BLOCK").includes("NEW_TERMS_WITHOUT_QUOTE"));
    assert.ok(codes(e, "BLOCK").includes("KEY_ATTRIBUTE_DIFFERS"), "the version still says 304");
  });

  test("linked updated quote: must itself contain the condition (extracted, compared, reviewed) — a link alone does not pass", async () => {
    const w = world();
    const { s, replyId } = await withStatement(w);
    const text316 = caseText("A").replace("304 stainless steel", "316 stainless steel");
    const add = w.qs.addVersion(s.request.id, s.seriesId, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: w.ps.get(s.request.id)!.revision,
      expectedLatestVersionId: s.versionId,
      version: { rawText: text316, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "updated quote (SYNTHETIC)", supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(add.status === "CREATED");
    const v2 = add.version.id;
    assert.equal(w.replies.linkQuote(P, s.request.id, replyId, v2, null, randomUUID()).status, "CREATED");
    w.model.next = JSON.stringify(JSON.parse(w.es.getRun(s.run.id)!.rawOutput!)).split("304 stainless steel").join("316 stainless steel");
    const run2 = await w.svc.run(P, s.request.id, s.seriesId, v2, { idempotencyKey: randomUUID(), rerun: true });
    assert.equal(run2.status, "FINISHED");
    const r2 = (run2 as { run: { id: string } }).run.id;
    // Linked and extracted, but the material is not reviewed yet → not accepted as containing the condition.
    reviewAll(w, s, { runId: r2, versionId: v2, skip: (p) => p === "items[0].material" });
    let e = preview(w, s, r2, v2);
    assert.ok(codes(e, "BLOCK").includes("NEW_TERMS_NOT_IN_VERSION") || codes(e, "BLOCK").includes("KEY_ATTRIBUTE_NOT_REVIEWED"), JSON.stringify(codes(e, "BLOCK")));
    assert.ok(!codes(e, "CONFIRM").includes("NEW_TERMS_LINKED"));
    reviewAll(w, s, { runId: r2, versionId: v2, skip: (p) => p !== "items[0].material" });
    e = preview(w, s, r2, v2);
    assert.equal(e.status, "READY_WITH_CONFIRMATIONS", JSON.stringify(codes(e, "BLOCK")));
    assert.ok(codes(e, "CONFIRM").includes("NEW_TERMS_LINKED"));
    assert.equal(approve(w, s, e, randomUUID(), {}, r2, v2).status, "CREATED");
  });
});

describe("payment bound to the approval (MOCK PayPal)", () => {
  test("happy path: amount and currency from the snapshot; one payment per approval; a second payment for the request is refused", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    const start = w.approvals.startPayment(P, s.request.id, approval.id);
    assert.equal(start.status, "CREATED");
    assert.equal(w.approvals.startPayment(P, s.request.id, approval.id).status, "EXISTING");
    const order = await w.approvals.createOrder(P, s.request.id, approval.id);
    assert.equal(order.status, "PAYPAL");
    const o = (order as { result: { code: string; orderId?: string } }).result;
    assert.equal(o.code, "ORDER_READY");
    assert.deepEqual(w.paypal.calls.create[0].input.amount, { currencyCode: "USD", value: "12.00" });
    w.paypal.approve(o.orderId!);
    const cap = await w.approvals.capture(P, s.request.id, approval.id, o.orderId);
    assert.equal((cap as { result: { code: string } }).result.code, "PAID");
    // Revoke after payment: the payment truth stays.
    w.approvals.revoke(P, s.request.id, approval.id, "test after payment", randomUUID());
    const v = w.approvals.view(P, s.request.id, approval.id)!;
    assert.equal(v.validity.state, "REVOKED");
    assert.equal(v.payments[0].status, "PAID");
  });

  test("invalid after the order was created → capture refused without any capture request; record keeps ORDER_CREATED", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    w.approvals.startPayment(P, s.request.id, approval.id);
    const order = (await w.approvals.createOrder(P, s.request.id, approval.id)) as { result: { orderId?: string } };
    w.paypal.approve(order.result.orderId!);
    editRequest(w, s.request.id, (i) => (i.items[1].quantity = "25"));
    const cap = (await w.approvals.capture(P, s.request.id, approval.id, order.result.orderId)) as { result: { code: string; record: { status: string } } };
    assert.equal(cap.result.code, "APPROVAL_INVALID");
    assert.equal(cap.result.record.status, "ORDER_CREATED");
    assert.equal(w.paypal.calls.capture.length, 0);
    assert.equal(w.approvals.view(P, s.request.id, approval.id)!.validity.state, "INVALIDATED");
  });

  test("invalid before order creation → no PayPal create request (not even a retry with the same id)", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    w.approvals.startPayment(P, s.request.id, approval.id);
    w.approvals.revoke(P, s.request.id, approval.id, "stop (test)", randomUUID());
    const out = (await w.approvals.createOrder(P, s.request.id, approval.id)) as { result: { code: string } };
    assert.equal(out.result.code, "APPROVAL_INVALID");
    assert.equal(w.paypal.calls.create.length, 0);
  });

  test("unknown capture outcome, then invalid: reconcile only reads; not captured → no new capture; captured → recorded PAID", async () => {
    // (a) PayPal never processed the capture.
    const w = world();
    const { s, approval } = await approved(w);
    w.approvals.startPayment(P, s.request.id, approval.id);
    const o = (await w.approvals.createOrder(P, s.request.id, approval.id)) as { result: { orderId?: string } };
    w.paypal.approve(o.result.orderId!);
    w.paypal.captureFaults.push("timeout-before-processing");
    const first = (await w.approvals.capture(P, s.request.id, approval.id, o.result.orderId)) as { result: { code: string } };
    assert.equal(first.result.code, "CAPTURE_UNKNOWN");
    const sent = w.paypal.calls.capture.length;
    editRequest(w, s.request.id, (i) => (i.items[0].quantity = "22"));
    const rec = (await w.approvals.reconcile(P, s.request.id, approval.id)) as { result: { code: string; record: { status: string } } };
    assert.equal(rec.result.code, "APPROVAL_INVALID");
    assert.equal(rec.result.record.status, "CAPTURE_UNKNOWN", "the unknown outcome is kept, not overwritten");
    assert.equal(w.paypal.calls.capture.length, sent, "no capture request was re-sent");

    // (b) PayPal captured, but the response and the follow-up lookup were lost.
    const w2 = world();
    const b = await approved(w2);
    w2.approvals.startPayment(P, b.s.request.id, b.approval.id);
    const o2 = (await w2.approvals.createOrder(P, b.s.request.id, b.approval.id)) as { result: { orderId?: string } };
    w2.paypal.approve(o2.result.orderId!);
    w2.paypal.captureFaults.push("timeout-after-processing");
    // Only the lookup right after the lost capture response fails (the pre-capture lookup succeeds).
    const captureOrder = w2.paypal.captureOrder.bind(w2.paypal);
    w2.paypal.captureOrder = async (orderId, requestId) => {
      try {
        return await captureOrder(orderId, requestId);
      } finally {
        w2.paypal.getFailures = 1;
      }
    };
    const c1 = (await w2.approvals.capture(P, b.s.request.id, b.approval.id, o2.result.orderId)) as { result: { code: string } };
    assert.equal(c1.result.code, "CAPTURE_UNKNOWN");
    w2.approvals.revoke(P, b.s.request.id, b.approval.id, "changed mind (test)", randomUUID());
    const c2 = (await w2.approvals.reconcile(P, b.s.request.id, b.approval.id)) as { result: { code: string } };
    assert.equal(c2.result.code, "PAID", "the real outcome is recorded even though the approval is no longer valid");
    assert.equal(w2.paypal.totalCaptures(), 1);
    // A new approval for the same request cannot lead to a second payment.
    assert.ok(codes(preview(w2, b.s), "BLOCK").includes("ALREADY_PAID"));
  });

  test("capture decision point: the validity check runs inside the CAPTURING transaction (a basis write must wait for it)", async () => {
    const w = world();
    const { s, approval } = await approved(w);
    w.approvals.startPayment(P, s.request.id, approval.id);
    const o = (await w.approvals.createOrder(P, s.request.id, approval.id)) as { result: { orderId?: string } };
    w.paypal.approve(o.result.orderId!);
    // While the guard runs, another connection tries to write: it cannot commit until the CAPTURING transition commits.
    const writer = new DatabaseSync(w.path);
    writer.exec("PRAGMA busy_timeout = 0");
    let blocked = false;
    const guarded = w.payments as unknown as { store: PaymentStore };
    const original = guarded.store.transitionChecked.bind(guarded.store);
    guarded.store.transitionChecked = (id, g, patch, at, check) =>
      original(id, g, patch, at, () => {
        try {
          writer.exec("BEGIN IMMEDIATE");
          writer.exec("ROLLBACK");
        } catch {
          blocked = true;
        }
        return check();
      });
    const cap = (await w.approvals.capture(P, s.request.id, approval.id, o.result.orderId)) as { result: { code: string } };
    writer.close();
    assert.equal(cap.result.code, "PAID");
    assert.ok(blocked, "no other writer could commit between the check and CAPTURING");
  });
});

describe("policy, HTTP and migration", () => {
  test("approve / pay entry points (30 Oct): the assigned approver approves and is recorded as that signed-in account; the owning buyer pays and cannot approve", async () => {
    assert.ok(canApproveRequest(A, "pr_x") && !canPayRequest(A, "pr_x"));
    assert.ok(canPayRequest(P, "pr_x") && !canApproveRequest(P, "pr_x"));
    const w = world();
    const s = await ready(w, "A");
    const e = preview(w, s);
    assert.equal(w.approvals.approve(P, s.request.id, { ...ids(s), previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID()).status, "FORBIDDEN", "the buyer cannot approve its own request");
    assert.equal(counts(w.path).approvals, 0);
    const out = approve(w, s, e);
    assert.equal(out.status, "CREATED");
    const approval = (out as { approval: { id: string } }).approval;
    const v = w.approvals.view(P, s.request.id, approval.id)!;
    assert.deepEqual(v.approval.actor, { kind: "APPROVER", id: A.id, authenticated: true });
    assert.match(v.actorLabel, /approver, signed in/);
    const stranger = { ...P, id: "u_other", access: { ...P.access, ownerOf: () => "u_someone-else" } };
    assert.equal(w.approvals.preview(stranger, s.request.id, ids(s)).status, "NOT_FOUND");
  });

  test("HTTP: preview GET, approve POST refuses unknown fields; payment steps refused while Sandbox payments are not enabled", async () => {
    const w = world();
    const s = await ready(w, "A");
    const base = `http://127.0.0.1:3000/api/procurements/${s.request.id}/approvals`;
    const pre = await handlePreview(new Request(`${base}?series=${s.seriesId}&version=${s.versionId}&run=${s.run.id}`, { headers: { host: "127.0.0.1:3000" } }), s.request.id, w.approvals, { enabled: true, auth: testGate() });
    assert.equal(pre.status, 200);
    const body = (await pre.json()) as { evaluation: Evaluation };
    const post = (extra: Record<string, unknown>) =>
      handleApprove(
        new Request(base, { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ ...ids(s), previewDigest: body.evaluation.digest, confirmed: body.evaluation.confirmKeys, ...extra }) }),
        s.request.id,
        w.approvals,
        { enabled: true, auth: testGate(A) },
      );
    assert.equal((await post({ amount: 1200 })).status, 422);
    const ok = await post({});
    assert.equal(ok.status, 201);
    const created = (await ok.json()) as { approval: { id: string } };
    const pay = await handlePaymentStep(
      new Request(`${base}/${created.approval.id}/payment`, { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }),
      s.request.id,
      created.approval.id,
      "start",
      w.approvals,
      { enabled: true, auth: testGate(), paymentsEnabled: false },
    );
    assert.equal(pay.status, 409);
    assert.equal(counts(w.path).payments, 0);
  });

  test("migration v13 → v14 on a copy: new tables only, existing rows untouched, backup written", async () => {
    const w = world();
    await approved(w);
    const raw = new DatabaseSync(w.path);
    const before = Number((raw.prepare("SELECT count(*) AS n FROM quote_extraction_reviews").get() as { n: number }).n);
    raw.exec(`DROP TABLE approval_payments; DROP TABLE approval_events; DROP TABLE approvals; DROP TABLE requirement_classifications; PRAGMA user_version = 13;`);
    raw.close();
    const backups = join(dir, "backups");
    const n0 = (() => {
      try {
        return readdirSync(backups).length;
      } catch {
        return 0;
      }
    })();
    const again = new ApprovalStore(w.path);
    open.push(again);
    const check = new DatabaseSync(w.path, { readOnly: true });
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 18);
    assert.equal(Number((check.prepare("SELECT count(*) AS n FROM approvals").get() as { n: number }).n), 0);
    assert.equal(Number((check.prepare("SELECT count(*) AS n FROM quote_extraction_reviews").get() as { n: number }).n), before);
    assert.equal((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    check.close();
    assert.ok(readdirSync(backups).length > n0);
  });

  test("request fingerprint ignores title and timestamps only", async () => {
    const w = world();
    const s = await ready(w, "A");
    const r = w.ps.get(s.request.id)!;
    assert.equal(requestFingerprint(r), requestFingerprint({ ...r, title: "other", updatedAt: "x", revision: 9 }));
    assert.notEqual(requestFingerprint(r), requestFingerprint({ ...r, items: r.items.map((i, n) => (n === 0 ? { ...i, notes: "x" } : i)) }));
  });
});
