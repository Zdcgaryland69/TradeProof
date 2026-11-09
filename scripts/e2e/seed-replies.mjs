// Seeds ONE fresh, clearly marked [TEST] record for the supplier-reply browser check (29 Oct): a SYNTHETIC request based
// on the stored LA-1 case with planted differences, its quote version 1 (the stored SYNTHETIC LA-1 text, source Test
// data), one extraction run that REPLAYS the stored LA-1 model output in MOCK mode (labelled MOCK, provider
// "e2e-replay"; no model call, never the API budget) and one clarification draft. Every run makes a new record, so
// the browser check does not depend on rows left by an earlier run, and nothing is deleted.
//
//   node scripts/e2e/seed-replies.mjs [label]     prints the ids as JSON
//
// Used by scripts/e2e/replies.e2e.mjs (label "e2e replies") and, once, for the owner's acceptance record.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(join(root, p)).href);

/** `owner` = { principal, id } of a buyer account in the target DB (since sign-in, 30 Oct: no anonymous seeding). */
export async function seedReplyRecord(label = "e2e replies", owner) {
  if (!owner?.principal || !owner?.id) throw new Error("seedReplyRecord needs an owner (a buyer account of the target DB)");
  const [{ ProcurementStore }, { validateProcurementInput }, { emptyInput }, { QuoteStore }, { ExtractionStore }, { ExtractionService }, { ComparisonService }, { ClarificationStore }, { ClarificationService }] = await Promise.all([
    load("src/server/procurement/store.ts"),
    load("src/server/procurement/validate.ts"),
    load("src/lib/procurement.ts"),
    load("src/server/quotes/store.ts"),
    load("src/server/extraction/store.ts"),
    load("src/server/extraction/service.ts"),
    load("src/server/comparison/service.ts"),
    load("src/server/clarification/store.ts"),
    load("src/server/clarification/service.ts"),
  ]);
  // SEED_DB: a copy for a dry run; default = the local app DB.
  const db = process.env.SEED_DB;
  if (!db) throw new Error("SEED_DB (a database copy) is required since sign-in (30 Oct)");
  const stored = JSON.parse(readFileSync(join(root, "samples", "synthetic", "live-acceptance", "stored-runs.synthetic.json"), "utf8")).cases["LA-1"];
  const P = owner.principal;
  const ps = new ProcurementStore(db);
  const qs = new QuoteStore(db);
  const es = new ExtractionStore(db);
  const cs = new ClarificationStore(db);
  try {
    const snap = stored.version.snapshot.record;
    const stamp = new Date().toISOString();
    const input = {
      ...emptyInput(),
      buyerType: "BUSINESS",
      buyerCompany: "Test Co (SYNTHETIC)",
      title: `[TEST] ${label} ${stamp} (SYNTHETIC)`,
      paymentTerms: "50% deposit, 50% before shipment",
      items: snap.items.map((i, n) => ({
        id: null,
        name: i.name,
        quantity: n === 0 ? "250" : i.quantity === null ? "" : String(i.quantity),
        unit: i.unit ?? "",
        material: n === 0 ? "316 stainless steel" : (i.material ?? ""),
        specification: i.specification ?? "",
        customization: i.customization ?? "",
        notes: "",
      })),
    };
    const v = validateProcurementInput(input, "create");
    if (!v.ok) throw new Error(`request invalid: ${JSON.stringify(v.errors)}`);
    const r = ps.create(v.value, "USER_INPUT", owner.id, "OPERATOR_SEED");
    const ids = Object.fromEntries(snap.items.map((old) => [old.id, r.items.find((x) => x.name === old.name).id]));
    const saved = qs.createSeries(r.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      name: `[TEST] ${label} quote (SYNTHETIC)`,
      supplierDisplayName: null,
      version: { rawText: stored.version.rawText, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "stored-runs.synthetic.json (LA-1)", supplierQuoteDate: null, revisionNote: null },
    });
    if (saved.status !== "CREATED") throw new Error(`quote not saved: ${saved.status}`);
    // A test double that replays the stored model output (MOCK). Not a model; no network.
    const model = {
      mode: "MOCK",
      provider: "e2e-replay",
      model: "stored-output",
      async complete() {
        let text = stored.run.rawOutput;
        for (const [from, to] of Object.entries(ids)) text = text.split(from).join(to);
        return { text, truncated: false, inputTokens: null, outputTokens: null };
      },
    };
    const svc = new ExtractionService(es, {
      resolveModel: () => ({ config: { state: "READY", mode: "MOCK", provider: model.provider, model: model.model }, model }),
      limits: { timeoutMs: 5000, maxAttempts: 1, retryDelayMs: 1 },
    });
    const o = await svc.run(P, r.id, saved.series.id, saved.version.id, { idempotencyKey: randomUUID(), rerun: true });
    if (o.status !== "FINISHED") throw new Error(`replayed run not finished: ${o.status}`);
    const clar = new ClarificationService(cs, new ComparisonService(es));
    const d = clar.create(P, r.id, saved.series.id, saved.version.id, o.run.id, null, null);
    if (d.status !== "CREATED") throw new Error(`draft not created: ${d.status}`);
    return {
      requestId: r.id,
      title: input.title,
      seriesId: saved.series.id,
      versionId: saved.version.id,
      runId: o.run.id,
      draftId: d.draft.id,
      questions: d.draft.generated.questions.map((q, i) => ({ n: i + 1, id: q.id, template: q.template, field: q.field })),
    };
  } finally {
    for (const s of [ps, qs, es, cs]) s.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { principalOf } = await import("./lib/e2e-auth.mjs");
  const db = process.env.SEED_DB;
  if (!db || !process.argv[3]) throw new Error("usage: SEED_DB=<copy> node scripts/e2e/seed-replies.mjs <label> <buyer username>");
  const p = await principalOf(db, process.argv[3]);
  try {
    console.log(JSON.stringify(await seedReplyRecord(process.argv[2] ?? "e2e replies", { principal: p.principal, id: p.principal.id }), null, 2));
  } finally {
    p.close();
  }
}
