// SYNTHETIC Copilot fixtures shared by tests/copilot.test.ts and scripts/copilot-cost-bounds.mts (2 Nov).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CopilotIntent } from "../../src/lib/copilot.ts";
import type { Principal } from "../../src/server/access/policy.ts";
import type { ClarificationService } from "../../src/server/clarification/service.ts";
import type { ReplyService } from "../../src/server/replies/service.ts";
import { P, reviewAll, seedCase, type CaseName, type SeedStores } from "./approval-fixtures.ts";

/** S-MIX: the mixed-language sample, unchanged (incl. its planted instruction), replayed with a correct reading. */
export function mixedOutput(lines: { tumbler: string; box: string | null }): string {
  const T = (value: string | null, quote: string | null = value) => ({ value, quote });
  const M = (amount: string | null, currency: string | null, quote: string | null) => ({ amount, currency, quote });
  const NONE = { value: null, quote: null };
  const NO_MONEY = { amount: null, currency: null, quote: null };
  const item = (o: Record<string, unknown>) => ({ name: NONE, quantity: NONE, unit: NONE, material: NONE, specification: NONE, logo: NONE, unitPrice: NO_MONEY, requestItemCandidates: [], ...o });
  const fee = (o: Record<string, unknown>) => ({ kind: NONE, description: NONE, amount: NO_MONEY, amountBasis: NONE, payer: NONE, payee: NONE, includedInQuote: NONE, statedAs: NONE, ...o });
  return JSON.stringify({
    supplierQuoteNumbers: [T("SQ-77/2026", "Quotation No. 报价单号: SQ-77/2026")],
    quoteDate: T("2026-10-20", "Date 日期: 2026-10-20"),
    currency: T("USD", "Total 合计: USD 1,700.00"),
    items: [
      item({ name: T("Stainless steel bottle 500ml 不锈钢保温杯", "1) Stainless steel bottle 500ml 不锈钢保温杯"), quantity: T("300", "300 pcs @ USD 3.20"), unit: T("pcs", "300 pcs @ USD 3.20"), unitPrice: M("3.20", "USD", "300 pcs @ USD 3.20"), requestItemCandidates: [lines.tumbler] }),
      item({ name: T("Stainless steel bottle 750ml", "2) Stainless steel bottle 750ml"), quantity: T("200", "200 pcs @ USD 3.80"), unit: T("pcs", "200 pcs @ USD 3.80"), unitPrice: M("3.80", "USD", "200 pcs @ USD 3.80"), requestItemCandidates: lines.box ? [lines.box] : [] }),
    ],
    total: M("1,700.00", "USD", "Total 合计: USD 1,700.00"),
    incoterm: T("FOB Ningbo", "Terms: FOB Ningbo"),
    leadTime: T("40 days after deposit", "40 days after deposit"),
    paymentTerms: T("30% deposit 70% before shipment", "30% deposit 70% before shipment"),
    fees: [
      fee({ kind: T("FREIGHT", "Freight 运费: to be advised 待定"), description: T("Freight 运费", "Freight 运费: to be advised 待定"), payer: T("BUYER", "paid by buyer 由买方承担"), statedAs: T("TO_BE_CONFIRMED", "to be advised 待定") }),
      fee({
        kind: T("PAYMENT_FEE", "Bank charges 银行手续费: USD 25.00, not included 不含"),
        description: T("Bank charges 银行手续费", "Bank charges 银行手续费: USD 25.00, not included 不含"),
        amount: M("25.00", "USD", "Bank charges 银行手续费: USD 25.00"),
        amountBasis: T("LUMP_SUM", "Bank charges 银行手续费: USD 25.00"),
        includedInQuote: T("NOT_INCLUDED", "USD 25.00, not included 不含"),
        statedAs: T("FIRM", "Bank charges 银行手续费: USD 25.00"),
      }),
    ],
  });
}
export const mixedFrom = (raw: string) => {
  const o = JSON.parse(raw) as { items: { requestItemCandidates: string[] }[] };
  return mixedOutput({ tumbler: o.items[0].requestItemCandidates[0], box: o.items[1]?.requestItemCandidates[0] ?? null });
};
export const MIXED_TEXT = () => readFileSync(join("samples", "synthetic", "supplier-quote-mixed-fees.synthetic.md"), "utf8").replace(/\r\n/g, "\n");
export const mixedRequest = {
  budgetMax: "5000.00",
  items: [
    { id: null, name: "Stainless steel bottle 500ml", quantity: "300", unit: "pcs", material: "", specification: "", customization: "", notes: "" },
    { id: null, name: "Stainless steel bottle 750ml", quantity: "200", unit: "pcs", material: "", specification: "", customization: "", notes: "" },
  ],
};


// ---------- the six proposed real asks (L1–L6, revised 2 Nov, later: all five buttons covered) ----------

export const ACCEPTANCE_REPLY_TEXT = "[SYNTHETIC] Quantity: we can do 20 pcs. About the total we will check.";

export interface AcceptanceCase {
  id: "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
  fixture: string;
  intent: CopilotIntent;
  requestId: string;
  seriesId: string;
  versionId: string;
}

interface AcceptanceStores extends SeedStores {
  clar: Pick<ClarificationService, "create">;
  replies: Pick<ReplyService, "saveReply" | "linkToDraft" | "answer">;
}

/**
 * Seeds the six SYNTHETIC records of the real-run list with the production services (MOCK replay runs, no model).
 * `owner` = the buyer who owns them (tests: the test buyer; the real run: a dedicated [TEST] buyer account).
 */
export async function seedAcceptanceCases(w: AcceptanceStores, label: string, owner?: { principal: Principal; ownerId: string }): Promise<AcceptanceCase[]> {
  const who = owner?.principal ?? P;
  const opts = owner ? { principal: owner.principal, ownerId: owner.ownerId, ownerSource: "OPERATOR_SEED" as const } : {};
  const seed = async (name: CaseName, tag: string, extra: Parameters<typeof seedCase>[3] = {}) => {
    const s = await seedCase(w, name, `Copilot ${tag} ${label}`, { ...opts, ...extra });
    reviewAll(w, s, { principal: who });
    return s;
  };
  const a = await seed("A", "L1");
  const b = await seed("B", "L2");
  const c = await seed("C", "L3");
  const r = await seed("B", "L4");
  const d = w.clar.create(who, r.request.id, r.seriesId, r.versionId, r.run.id, null, null);
  if (d.status !== "CREATED") throw new Error(`draft: ${d.status}`);
  const [q1, q2] = d.draft.generated.questions;
  const reply = w.replies.saveReply(who, r.request.id, r.seriesId, { rawText: ACCEPTANCE_REPLY_TEXT, source: "TEST_FIXTURE" }, randomUUID());
  if (reply.status !== "CREATED") throw new Error(`reply: ${reply.status}`);
  const link = w.replies.linkToDraft(who, r.request.id, d.draft.id, reply.reply.id, 1, null, randomUUID());
  if (link.status !== "CREATED") throw new Error(`link: ${link.status}`);
  for (const [q, body] of [
    [q1, { status: "ANSWERED", excerpt: "we can do 20 pcs" }],
    [q2, { status: "PARTLY_ANSWERED", excerpt: "About the total we will check" }],
  ] as const) {
    const out = w.replies.answer(who, r.request.id, d.draft.id, link.link.id, q.id, null, body, randomUUID());
    if (out.status !== "SAVED") throw new Error(`answer: ${out.status}`);
  }
  const m = await seed("A", "L5", { text: MIXED_TEXT(), output: mixedFrom, request: mixedRequest });
  const n = await seedCase(w, "A", `Copilot L6 ${label}`, opts);
  const v2 = w.qs.addVersion(n.request.id, n.seriesId, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: w.ps.get(n.request.id)!.revision,
    expectedLatestVersionId: n.versionId,
    version: { rawText: "[SYNTHETIC] Revised quote v2 — not extracted yet.", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "Copilot L6", supplierQuoteDate: null, revisionNote: null },
  } as never);
  if (v2.status !== "CREATED") throw new Error(`v2: ${v2.status}`);
  const at = (id: AcceptanceCase["id"], fixture: string, s: { request: { id: string }; seriesId: string; versionId: string }, intent: CopilotIntent, versionId = s.versionId): AcceptanceCase => ({ id, fixture, intent, requestId: s.request.id, seriesId: s.seriesId, versionId });
  return [
    at("L1", "S-A ready", a, "WHY_NOT_APPROVABLE"),
    at("L2", "S-B quantity + total differences", b, "DIFFERENCES"),
    at("L3", "S-C fees outside this payment", c, "PAYMENT_AMOUNT"),
    at("L4", "S-REPLY after a supplier reply", r, "AFTER_REPLY"),
    at("L5", "S-MIX planted instruction", m, "PAYMENT_AMOUNT"),
    at("L6", "S-NORUN newest version without a run", n, "NEXT_STEP", (v2 as { version: { id: string } }).version.id),
  ];
}
