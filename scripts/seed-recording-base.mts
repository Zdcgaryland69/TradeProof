// Operator seed (3 Nov 2026) of the BASE MATERIAL for a recorded MOCK demo, on a MOCK database (never the main one):
// the SYNTHETIC demo request (revision 1, owned by the buyer), quote version 1 (the Chinese demo quote) and one MOCK
// extraction run of it. NOTHING ELSE: no value review, no match, no draft, no reply, no answer, no request revision, no
// classification, no approver. Those are the presenter's own steps (docs/demo-3min.md "Prepared by the presenter").
//
//   npm run mock:seed-base [buyer]        (via scripts/local-mock.mjs, which sets SEED_DB; default buyer: buyer-a)
//
// No model, token-count or PayPal request: the run uses the canned MOCK output of the built-in demo quote.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AuthService } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { resolveExtractionModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { loadDemoInput } from "../src/server/procurement/demo.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { shortProcurementId } from "../src/lib/procurement.ts";

const db = process.env.SEED_DB ? resolve(process.env.SEED_DB) : null;
const main = resolve("data", "sandbox-payments.sqlite");
if (!db || db.toLowerCase() === main.toLowerCase()) throw new Error("SEED_DB must name a MOCK database (never data/sandbox-payments.sqlite)");
const [buyerName = "buyer-a"] = process.argv.slice(2);

const auth = new AuthService(new AuthStore(db));
const ps = new ProcurementStore(db);
const qs = new QuoteStore(db);
const es = new ExtractionStore(db);
try {
  const buyer = auth.principalOfAccount(buyerName);
  if (!buyer || buyer.kind !== "BUYER") throw new Error(`buyer account "${buyerName}" missing in this database`);
  const mock = resolveExtractionModel({ AI_PROVIDER: "mock" });
  if (mock.config.state !== "READY" || mock.config.mode !== "MOCK") throw new Error("MOCK extraction not available");
  const svc = new ExtractionService(es, { resolveModel: () => mock });

  const input = loadDemoInput()!;
  const v = validateProcurementInput(input, "create");
  if (!v.ok) throw new Error("demo request invalid");
  const request = ps.create(v.value, "DEMO_SAMPLE", buyer.id, "OPERATOR_SEED");
  const rawText = readFileSync(join("samples", "synthetic", "supplier-quote-zh.synthetic.md"), "utf8").replace(/\r\n/g, "\n");
  const s1 = qs.createSeries(request.id, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: 1,
    name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118 (中文)",
    supplierDisplayName: "宁波示例日用品有限公司（虚构）",
    version: { rawText, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "samples/synthetic/supplier-quote-zh.synthetic.md", supplierQuoteDate: "2026-10-15", revisionNote: null },
  }) as { status: string; series: { id: string }; version: { id: string } };
  if (s1.status !== "CREATED") throw new Error(`quote v1: ${s1.status}`);
  const run = (await svc.run(buyer, request.id, s1.series.id, s1.version.id, { idempotencyKey: randomUUID(), rerun: true })) as unknown as { status: string; run: { id: string } };
  if (run.status !== "FINISHED") throw new Error(`MOCK run: ${run.status}`);

  console.log(JSON.stringify({ requestId: request.id, reference: shortProcurementId(request.id), seriesId: s1.series.id, v1: s1.version.id, mockRun: run.run.id, reviews: 0, note: "base material only — every review and decision is left to the presenter" }, null, 2));
} finally {
  for (const s of [auth.store, ps, qs, es]) s.close();
}
