// Diagnostic entry for the open test-process crash (segmentation fault, exit 139) seen on 26 Oct in the
// budget thread tests — see docs/diagnostics/budget-threads-segfault.md. Temp databases only; no model,
// no PayPal, no real ledger.
//
// Usage: node scripts/diag-budget-threads.mjs [runs=10] [--isolated]
//   default     : the ORIGINAL combination — all "concurrent reservations" thread tests in ONE process
//                 (node runs tests/budget.test.ts directly, no test-runner child), repeated <runs> times.
//   --isolated  : each thread test in its OWN process. This is an ISOLATION measure for comparison only,
//                 not a root-cause fix; a clean result here does not mean the crash is solved.
// Prints exit-code counts; logs of failing runs are kept in a temp folder (path printed).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const isolated = args.includes("--isolated");
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
const GROUP = "concurrent reservations";
const SINGLE = ["^12 threads race for the last 3", "open their connections at the same moment", "same request key", "^10 threads race"];
const patterns = isolated ? SINGLE : [GROUP];

const env = { ...process.env };
for (const k of ["AI_PROVIDER", "AI_MODEL", "AI_API_KEY", "ANTHROPIC_API_KEY"]) delete env[k];
const logs = mkdtempSync(join(tmpdir(), "tp-diag-threads-"));
const codes = new Map();
let failedRuns = 0;

console.log(`node ${process.version} · sqlite ${process.versions.sqlite} · ${process.platform}/${process.arch} · mode ${isolated ? "ISOLATED (one process per test — isolation, not a fix)" : "ORIGINAL (all thread tests in one process)"} · runs ${runs}`);
for (let i = 1; i <= runs; i++) {
  let failed = false;
  for (const pattern of patterns) {
    const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", `--test-name-pattern=${pattern}`, "tests/budget.test.ts"], { env, encoding: "utf8" });
    const code = r.status ?? `signal ${r.signal}`;
    codes.set(code, (codes.get(code) ?? 0) + 1);
    if (r.status !== 0) {
      failed = true;
      writeFileSync(join(logs, `run${i}-${pattern.replace(/\W+/g, "_")}.txt`), `exit ${code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    }
  }
  if (failed) failedRuns++;
}
console.log(`runs with a failure: ${failedRuns} / ${runs}`);
for (const [code, n] of codes) console.log(`  exit ${code}: ${n} process(es)${code === 139 || code === 3221225477 ? "  ← segmentation fault / access violation" : ""}`);
console.log(`logs of failing runs: ${failedRuns ? logs : "(none)"}`);
