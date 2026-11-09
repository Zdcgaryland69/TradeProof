// Prints the deterministic facts, links and next step of the six real-run cases (L1–L6) and whether the MOCK
// explanation passes the validator — on SYNTHETIC records in a temporary database. No model, no network, no main DB.
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-cases-preview.mts [--as-approver]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorld } from "./copilot-world.mts";
import { seedAcceptanceCases } from "../tests/helpers/copilot-fixtures.ts";
import { A, P } from "../tests/helpers/approval-fixtures.ts";
import { mockExplanation } from "../src/server/copilot/mock.ts";
import { validateExplanation } from "../src/server/copilot/validate.ts";
import { buildCopilot } from "../src/server/copilot/facts.ts";

const dir = mkdtempSync(join(tmpdir(), "tradeproof-copilot-preview-"));
const w = openWorld(join(dir, "preview.sqlite"));
try {
  const cases = await seedAcceptanceCases(w, "preview");
  const who = process.argv.includes("--as-approver") ? A : P;
  for (const c of cases) {
    const built = buildCopilot(w.src, who, c.requestId, { seriesId: c.seriesId, versionId: c.versionId, runId: null, baseRunId: null }, c.intent)!;
    const v = validateExplanation(mockExplanation(c.intent, built.facts, built.links, built.nextStep?.link ?? null), { intent: c.intent, facts: built.facts, links: built.links });
    console.log(`\n=== ${c.id} ${c.fixture} · ${c.intent} · MOCK validator ${v.ok ? "PASS" : `FAIL ${v.problems.join("; ")}`}`);
    for (const f of built.facts) console.log(`${f.id}${f.trusted ? "" : " [supplier text]"} [${f.tags.join(",")}] ${f.text.split("\n")[0].slice(0, 220)}`);
    for (const l of built.links) console.log(`${l.id} ${l.label} → ${l.href.replace(/[0-9a-f-]{36}/g, "…")}`);
    console.log(`next step: ${built.nextStep?.text} (${built.nextStep?.link})`);
  }
} finally {
  w.close();
  rmSync(dir, { recursive: true, force: true });
}
