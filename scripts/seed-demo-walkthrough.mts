// Operator seed (3 Nov) for a CHECK of the MOCK demo flow on a DATABASE COPY: one [SYNTHETIC / DEMO] record owned by an
// existing buyer account of that copy, prepared through the normal services up to "approver assigned", so that the
// remaining live steps (look at differences / clarification, approver approves, buyer pays in MOCK) can be checked.
//
//   SEED_DB=<copy> node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/seed-demo-walkthrough.mts [buyer] [approver]
//       defaults: buyer-a, approver. Refuses the main database. No model, token-count or PayPal request (MOCK extraction
//       of the built-in demo quotes only).
//
// IMPORTANT — what this is NOT: the value reviews, answers and classifications below are written by this OPERATOR script
// as the buyer (source OPERATOR_SEED for the ownership; like the 30 Oct access demo), so that a check does not need
// ~40 clicks. They are not a person's review. For a recorded demo the presenter prepares the record by hand with
// docs/demo-script.md (regression script) and reviews every value before recording (docs/demo-3min.md).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApprovalService } from "../src/server/approval/service.ts";
import { ApprovalStore } from "../src/server/approval/store.ts";
import { AuthService } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { ClarificationService } from "../src/server/clarification/service.ts";
import { ClarificationStore } from "../src/server/clarification/store.ts";
import { ComparisonService } from "../src/server/comparison/service.ts";
import { resolveExtractionModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { loadDemoInput } from "../src/server/procurement/demo.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { ReplyService } from "../src/server/replies/service.ts";
import { ReplyStore } from "../src/server/replies/store.ts";
import { recordToInput } from "../src/lib/procurement.ts";
import { reviewAll } from "../tests/helpers/approval-fixtures.ts";

const db = process.env.SEED_DB ? resolve(process.env.SEED_DB) : null;
const main = resolve("data", "sandbox-payments.sqlite");
if (!db || db.toLowerCase() === main.toLowerCase()) throw new Error("SEED_DB must name a database COPY (never data/sandbox-payments.sqlite)");
const [buyerName = "buyer-a", approverName = "approver"] = process.argv.slice(2);
const sample = (f: string) => readFileSync(join("samples", "synthetic", f), "utf8").replace(/\r\n/g, "\n");
const must = <T extends { status: string }>(o: T, ok: string[], what: string): T => {
  if (!ok.includes(o.status)) throw new Error(`${what}: ${JSON.stringify(o).slice(0, 400)}`);
  return o;
};

const auth = new AuthService(new AuthStore(db));
const ps = new ProcurementStore(db);
const qs = new QuoteStore(db);
const es = new ExtractionStore(db);
const cs = new ClarificationStore(db);
const rs = new ReplyStore(db);
const aps = new ApprovalStore(db);
const pay = new PaymentStore(db);
try {
  const buyer = auth.principalOfAccount(buyerName);
  const approver = auth.principalOfAccount(approverName);
  if (!buyer || buyer.kind !== "BUYER" || !approver || approver.kind !== "APPROVER") throw new Error("buyer / approver account missing in the copy");
  const mock = resolveExtractionModel({ AI_PROVIDER: "mock" });
  if (mock.config.state !== "READY" || mock.config.mode !== "MOCK") throw new Error("MOCK extraction not available");
  const svc = new ExtractionService(es, { resolveModel: () => mock });
  const comparison = new ComparisonService(es);
  const clar = new ClarificationService(cs, comparison);
  const replies = new ReplyService(rs, cs);
  const approvals = new ApprovalService({ store: aps, extraction: es, procurement: ps, replies, replyStore: rs, drafts: cs, payments: () => new PaymentService({ store: pay, gateway: null as never, payeeMerchantId: "n/a" }), payee: () => ({ configured: false, merchantId: null }) });
  const stores = { ps, qs, es, svc, model: null as never };

  // 1. Request (Load demo), quote v1 (Chinese demo), MOCK run, review.
  const input = loadDemoInput()!;
  input.title = `${input.title} · walkthrough ${new Date().toISOString().slice(0, 16)}Z`;
  const v = validateProcurementInput(input, "create");
  if (!v.ok) throw new Error("demo request invalid");
  const request = ps.create(v.value, "DEMO_SAMPLE", buyer.id, "OPERATOR_SEED");
  const s1 = must(qs.createSeries(request.id, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118 (中文)", supplierDisplayName: "宁波示例日用品有限公司（虚构）", version: { rawText: sample("supplier-quote-zh.synthetic.md"), contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "samples/synthetic/supplier-quote-zh.synthetic.md", supplierQuoteDate: "2026-10-15", revisionNote: null } }), ["CREATED"], "quote v1") as { status: string; series: { id: string }; version: { id: string } };
  const run1 = must(await svc.run(buyer, request.id, s1.series.id, s1.version.id, { idempotencyKey: randomUUID(), rerun: true }), ["FINISHED"], "run v1") as unknown as { run: { id: string } };
  const seeded1 = { request, seriesId: s1.series.id, versionId: s1.version.id, run: run1.run as never, lines: { tumbler: request.items[0].id, box: null } };
  const n1 = reviewAll(stores as never, seeded1 as never, { principal: buyer });

  // 2. Clarification draft from the comparison; supplier reply saved on its own and linked; two answers.
  const draft = must(clar.create(buyer, request.id, s1.series.id, s1.version.id, run1.run.id, null, null), ["CREATED", "EXISTING"], "draft") as unknown as { draft: { id: string; generated: { questions: { id: string; template: string }[] } } };
  const REPLY = "SYNTHETIC / DEMO reply (fictional). [Q1] 数量可以做到 500 个。[Q2] 可以改用 304 不锈钢，单价调整为人民币 26.80 元/个，新报价单随后发送。";
  const reply = must(replies.saveReply(buyer, request.id, s1.series.id, { rawText: REPLY, source: "USER_PASTE", channelNote: "e-mail (SYNTHETIC)" }, randomUUID()), ["CREATED"], "reply") as unknown as { reply: { id: string } };
  const link = must(replies.linkToDraft(buyer, request.id, draft.draft.id, reply.reply.id, 1, null, randomUUID()), ["CREATED", "LINKED"], "link") as unknown as { link: { id: string } };
  const qid = (t: string) => draft.draft.generated.questions.find((q) => q.template === t)!.id;
  must(replies.answer(buyer, request.id, draft.draft.id, link.link.id, qid("QUANTITY_DIFFERS"), null, { status: "ANSWERED", excerpt: "[Q1] 数量可以做到 500 个。" }, randomUUID()), ["SAVED"], "answer Q1");
  must(replies.answer(buyer, request.id, draft.draft.id, link.link.id, qid("MATERIAL_DIFFERS"), null, { status: "PARTLY_ANSWERED", excerpt: "[Q2] 可以改用 304 不锈钢，单价调整为人民币 26.80 元/个，新报价单随后发送。" }, randomUUID()), ["SAVED"], "answer Q2");

  // 3. Buyer revises the request to a 20-piece SAMPLE ORDER (purpose stated), then quote v2 (revised sample-order demo).
  const r1 = ps.get(request.id)!;
  const in2 = recordToInput(r1);
  in2.items[0].quantity = "20";
  in2.budgetMax = "100.00";
  in2.paymentTerms = "100% advance payment before shipment";
  in2.additionalRequirements = "SYNTHETIC / DEMO DATA — fictional. Sample order: 20 pcs to check quality before a main order of 500 pcs. Incoterm: FOB Ningbo; ship by 2026-12-10. Maximum unit price: USD 3.60 / pcs.";
  const u = validateProcurementInput(in2, "update");
  if (!u.ok) throw new Error("revision invalid");
  must(ps.update(request.id, r1.revision, u.value) as { status: string }, ["UPDATED"], "request revision 2");
  const s2 = must(qs.addVersion(request.id, s1.series.id, { idempotencyKey: randomUUID(), expectedRequestRevision: 2, expectedLatestVersionId: s1.version.id, version: { rawText: sample("supplier-quote-revised.synthetic.md"), contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "samples/synthetic/supplier-quote-revised.synthetic.md", supplierQuoteDate: "2026-11-03", revisionNote: "After supplier reply 1 (Q1 / Q2): sample order, 304, laser, USD, 100 % before shipment (SYNTHETIC)" } }), ["CREATED"], "quote v2") as { status: string; version: { id: string } };
  const run2 = must(await svc.run(buyer, request.id, s1.series.id, s2.version.id, { idempotencyKey: randomUUID(), rerun: true }), ["FINISHED"], "run v2") as unknown as { run: { id: string } };
  const n2 = reviewAll(stores as never, { ...seeded1, versionId: s2.version.id, run: run2.run } as never, { principal: buyer, runId: run2.run.id, versionId: s2.version.id });

  // 4. Free-text requirements classified with reasons (the sample-order purpose is a key condition the quote states).
  const r2 = ps.get(request.id)!;
  must(approvals.classify(buyer, request.id, s1.series.id, s2.version.id, { subject: `ITEM_NOTES:${r2.items[0].id}`, decision: "NOT_KEY", reason: "Label marking the item as fictional demo data; not an order condition." }, randomUUID()) as { status: string }, ["CREATED"], "classify notes");
  must(approvals.classify(buyer, request.id, s1.series.id, s2.version.id, { subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_IN_QUOTE", reason: "Sample order of 20 pcs — the quote states 样品单; FOB and ship date are checked by the rules; unit price USD 3.40 is within USD 3.60.", excerpt: "20 个（样品单）" }, randomUUID()) as { status: string }, ["CREATED"], "classify additional requirements");

  // 5. Approver assigned (owner action, audited).
  must(auth.setApprover(buyer, request.id, approver.id, "GRANT"), ["CHANGED", "UNCHANGED"], "assign approver");

  console.log(JSON.stringify({ requestId: request.id, seriesId: s1.series.id, v1: s1.version.id, v2: s2.version.id, run2: run2.run.id, draftId: draft.draft.id, run1: run1.run.id, reviews: [n1, n2], note: "approval status: check on the approval page (the app uses its configured payee)" }, null, 2));
} finally {
  for (const s of [auth.store, ps, qs, es, cs, rs, aps, pay]) s.close();
}
