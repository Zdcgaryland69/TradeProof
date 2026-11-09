// Offline: compare the prompt actually sent in a live run (evidence) with the prompt the CURRENT code builds for the same
// record (consistent DB copy, read only). Only the per-call random nonce of the supplier-text markers is aligned.
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-prompt-diff.mts --evidence <run dir> --db <copy> --cases L4,L5
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuthService } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { buildCopilot } from "../src/server/copilot/facts.ts";
import { buildCopilotPrompt } from "../src/server/copilot/prompt.ts";
import { openWorld } from "./copilot-world.mts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const evidence = resolve(arg("--evidence") ?? "");
const db = resolve(arg("--db") ?? "");
if (db.toLowerCase() === resolve("data", "sandbox-payments.sqlite").toLowerCase()) throw new Error("use a COPY");
const ro = new DatabaseSync(db, { readOnly: true });
const store = new AuthStore(db);
const auth = new AuthService(store);
const w = openWorld(db);

function lineDiff(a: string, b: string): string[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const out: string[] = [];
  const setB = new Set(B);
  const setA = new Set(A);
  for (const l of A) if (!setB.has(l)) out.push(`- ${l}`);
  for (const l of B) if (!setA.has(l)) out.push(`+ ${l}`);
  return out;
}

try {
  for (const id of (arg("--cases") ?? "L4,L5").split(",")) {
    const rec = JSON.parse(readFileSync(join(evidence, `${id}.json`), "utf8"));
    const e = rec.evidence;
    const owner = auth.principalOfAccount((ro.prepare("SELECT p.username AS u FROM principals p JOIN procurement_owners o ON o.principal_id = p.id WHERE o.request_id = ?").get(rec.case.requestId) as { u: string }).u)!;
    const built = buildCopilot(w.src, owner, rec.case.requestId, { seriesId: rec.case.seriesId, versionId: rec.case.versionId, runId: null, baseRunId: null }, rec.case.intent)!;
    const nonce = /<<<SUPPLIER_TEXT F\d+ ([0-9a-f]+)>>>/.exec(e.prompt.user)?.[1] ?? "000000000000";
    const now = buildCopilotPrompt(rec.case.intent, built.facts, built.links, nonce);
    const sameSystem = now.system === e.prompt.system;
    const sameUser = now.user === e.prompt.user;
    console.log(`\n=== ${id} ${rec.case.intent}: system ${sameSystem ? "IDENTICAL" : "DIFFERENT"} · user (facts + supplier text + links) ${sameUser ? "IDENTICAL" : "DIFFERENT"}`);
    console.log(`    sent: rules ${JSON.stringify(e.rules)}, ${e.prompt.bundleChars} chars / ${e.prompt.utf8Bytes} bytes; now: ${now.bundleChars} chars / ${Buffer.byteLength(now.system) + Buffer.byteLength(now.user)} bytes`);
    if (!sameSystem) for (const l of lineDiff(e.prompt.system, now.system)) console.log(`    system ${l}`);
    if (!sameUser) for (const l of lineDiff(e.prompt.user, now.user)) console.log(`    user   ${l.slice(0, 300)}`);
  }
} finally {
  w.close();
  store.close();
  ro.close();
}
