// Seeds the owner's MOCK acceptance set (2 Nov, later) into a database COPY — refuses the main DB. Six NEW [TEST] SYNTHETIC
// records (the L1–L6 cases), owner = the named buyer account (OPERATOR_SEED), MOCK replay runs (no model); the named
// approver is assigned to the S-A record through the production AuthService.setApprover. No password is read, set or
// printed; no existing record is touched.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-mock-acceptance-seed.mts --db <copy> --buyer buyer-a --approver approver
import { resolve } from "node:path";
import { AuthService } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { seedAcceptanceCases } from "../tests/helpers/copilot-fixtures.ts";
import { openWorld } from "./copilot-world.mts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const db = resolve(arg("--db") ?? "");
if (!arg("--db") || db.toLowerCase() === resolve("data", "sandbox-payments.sqlite").toLowerCase()) throw new Error("--db must name a COPY, never the main database");
const store = new AuthStore(db);
const auth = new AuthService(store);
const buyer = auth.principalOfAccount(arg("--buyer") ?? "");
const approver = auth.principalOfAccount(arg("--approver") ?? "");
if (!buyer || buyer.kind !== "BUYER" || !approver || approver.kind !== "APPROVER") throw new Error("--buyer must be a buyer and --approver an approver account of this copy");
const w = openWorld(db);
try {
  const cases = await seedAcceptanceCases(w, `MOCK acceptance ${new Date().toISOString().slice(0, 10)}`, { principal: buyer, ownerId: buyer.id });
  const sa = cases.find((c) => c.id === "L1")!;
  const g = auth.setApprover(buyer, sa.requestId, approver.id, "GRANT");
  if (g.status === "NOT_FOUND" || g.status === "INVALID") throw new Error(`grant: ${JSON.stringify(g)}`);
  const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
  console.log(JSON.stringify(cases.map((c) => ({ ...c, title: w.ps.get(c.requestId)!.title, quotes: `${base}/procurements/${c.requestId}/quotes?series=${c.seriesId}&version=${c.versionId}`, request: `${base}/procurements/${c.requestId}` })), null, 1));
} finally {
  w.close();
  store.close();
}
