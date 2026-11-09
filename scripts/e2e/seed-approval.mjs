// Seeds a fresh, clearly marked set of [TEST] approval records (29 Oct) from the SYNTHETIC approval cases
// (tests/helpers/approval-fixtures.ts): A complete (USD 12.00), B inconsistent (quantity + total), C with fees outside
// this payment, and the ORIGINAL unchanged 30 % deposit sample as a blocked case. Each gets a request, quote v1, one
// extraction run that REPLAYS a hand-written SYNTHETIC output in MOCK mode (labelled MOCK, no model call, never the
// API budget) and the user's reviews. Every run makes new records; nothing is deleted or changed.
//
//   node scripts/e2e/seed-approval.mjs [label] [cases]     prints the ids and page URLs as JSON
//       cases: comma-separated subset of A,B,C,DEPOSIT (default all), e.g. "A" for the 30 Oct payment-loop record
//
// Used by scripts/e2e/approval.e2e.mjs (label "e2e approval"), scripts/e2e/approval-payment.e2e.mjs (on a database
// copy, SEED_DB) and, once each, for the owner's acceptance sets.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(join(root, p)).href);

/** `owner` = { principal, id } of a buyer account in the target DB (since sign-in, 30 Oct: no anonymous seeding). */
export async function seedApprovalSet(label = "e2e approval", base = process.env.BASE_URL ?? "http://127.0.0.1:3000", cases = ["A", "B", "C", "DEPOSIT"], owner) {
  if (!owner?.principal || !owner?.id) throw new Error("seedApprovalSet needs an owner (a buyer account of the target DB)");
  const [{ ProcurementStore }, { QuoteStore }, { ExtractionStore }, fx] = await Promise.all([
    load("src/server/procurement/store.ts"),
    load("src/server/quotes/store.ts"),
    load("src/server/extraction/store.ts"),
    load("tests/helpers/approval-fixtures.ts"),
  ]);
  // SEED_DB: a copy for a dry run; default = the local app DB.
  const db = process.env.SEED_DB;
  if (!db) throw new Error("SEED_DB (a database copy) is required since sign-in (30 Oct)");
  const ps = new ProcurementStore(db);
  const qs = new QuoteStore(db);
  const es = new ExtractionStore(db);
  const model = fx.replayModel();
  const svc = fx.replayService(es, model);
  const w = { ps, qs, es, svc, model };
  const stamp = new Date().toISOString();
  const out = { label, stamp, cases: {} };
  try {
    for (const name of cases) {
      if (!["A", "B", "C", "DEPOSIT"].includes(name)) throw new Error(`unknown case ${name}`);
      const s = await fx.seedCase(w, name, `${name} — ${label} ${stamp}`, { principal: owner.principal, ownerId: owner.id, ownerSource: "OPERATOR_SEED" });
      const reviews = fx.reviewAll(w, s, { principal: owner.principal });
      out.cases[name] = {
        requestId: s.request.id,
        seriesId: s.seriesId,
        versionId: s.versionId,
        runId: s.run.id,
        reviews,
        approvalUrl: `${base}/procurements/${s.request.id}/quotes/approval?series=${s.seriesId}&version=${s.versionId}&run=${s.run.id}`,
        compareUrl: `${base}/procurements/${s.request.id}/quotes/compare?series=${s.seriesId}&version=${s.versionId}&run=${s.run.id}`,
        requestUrl: `${base}/procurements/${s.request.id}`,
      };
    }
  } finally {
    ps.close();
    qs.close();
    es.close();
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cases = process.argv[3] ? process.argv[3].split(",") : undefined;
  const { principalOf } = await import("./lib/e2e-auth.mjs");
  const db = process.env.SEED_DB;
  if (!db || !process.argv[4]) throw new Error("usage: SEED_DB=<copy> node scripts/e2e/seed-approval.mjs <label> <cases|all> <buyer username>");
  const p = await principalOf(db, process.argv[4]);
  try {
    console.log(JSON.stringify(await seedApprovalSet(process.argv[2] ?? "e2e approval", undefined, process.argv[3] === "all" ? undefined : cases, { principal: p.principal, id: p.principal.id }), null, 2));
  } finally {
    p.close();
  }
}
