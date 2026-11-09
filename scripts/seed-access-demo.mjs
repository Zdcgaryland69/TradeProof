// Local operator step (30 Oct): new, clearly marked [TEST] SYNTHETIC records for the sign-in / access acceptance —
// one owned by Buyer A, one owned by Buyer B. Ownership is written here by the operator (source OPERATOR_SEED),
// never by a client. No existing record is assigned or changed. Needs the accounts (npm run accounts:setup).
//
//   npm run accounts:seed-demo        prints ids and page URLs (no secrets); also data/acceptance-access-30oct.json
//
// Each record: request (approval case A, USD 12.00, 100 % once) + quote v1 + one extraction run that REPLAYS a
// hand-written SYNTHETIC output in MOCK mode (labelled MOCK; no model call, no API budget) + the buyer's reviews,
// written as that buyer through the normal services. No approver is assigned — that is part of the acceptance.
// SEED_BUYER_A / SEED_BUYER_B (3 Nov, browser check on a copy only): other buyer usernames; default buyer-a / buyer-b.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(join(root, p)).href);
const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";

const [{ ProcurementStore }, { QuoteStore }, { ExtractionStore }, { AuthStore }, { AuthService }, { APP_DB_PATH }, fx] = await Promise.all([
  load("src/server/procurement/store.ts"),
  load("src/server/quotes/store.ts"),
  load("src/server/extraction/store.ts"),
  load("src/server/auth/store.ts"),
  load("src/server/auth/service.ts"),
  load("src/server/db/location.ts"),
  load("tests/helpers/approval-fixtures.ts"),
]);

const db = process.env.SEED_DB ?? APP_DB_PATH;
const auth = new AuthService(new AuthStore(db));
const ps = new ProcurementStore(db);
const qs = new QuoteStore(db);
const es = new ExtractionStore(db);
const model = fx.replayModel();
const w = { ps, qs, es, svc: fx.replayService(es, model), model };
const stamp = new Date().toISOString();
const out = { stamp, records: {} };
try {
  for (const [key, username] of [
    ["A", process.env.SEED_BUYER_A || "buyer-a"],
    ["B", process.env.SEED_BUYER_B || "buyer-b"],
  ]) {
    const buyer = auth.principalOfAccount(username);
    if (!buyer || buyer.kind !== "BUYER") throw new Error(`account ${username} missing — run npm run accounts:setup first`);
    const s = await fx.seedCase(w, "A", `access demo — Buyer ${key} ${stamp}`, { principal: buyer, ownerId: buyer.id, ownerSource: "OPERATOR_SEED" });
    const reviews = fx.reviewAll(w, s, { principal: buyer });
    auth.audit({ action: "OPERATOR_SEED_OWNER", objectType: "REQUEST", objectId: s.request.id, outcome: "OK", detail: { owner: buyer.id } });
    out.records[key] = {
      owner: username,
      requestId: s.request.id,
      seriesId: s.seriesId,
      versionId: s.versionId,
      runId: s.run.id,
      reviews,
      requestUrl: `${base}/procurements/${s.request.id}`,
      approvalUrl: `${base}/procurements/${s.request.id}/quotes/approval?series=${s.seriesId}&version=${s.versionId}&run=${s.run.id}`,
    };
  }
  if (!process.env.SEED_DB) writeFileSync(join(root, "data", "acceptance-access-30oct.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} finally {
  ps.close();
  qs.close();
  es.close();
  auth.store.close();
}
