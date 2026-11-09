// Real Copilot acceptance run (L1–L6, docs/copilot-cases.md §2.9). PREPARED — NOT RUN LIVE (needs the owner's
// explicit authorisation of the final list and the US$0.20 cap).
//
// Production path, no test back door: a dedicated [TEST] buyer account is created for the run (random password held in
// this process only, never printed or stored), signed in through AuthService.login (real session); the six SYNTHETIC
// records are seeded with that account as owner (OPERATOR_SEED) through the production services (MOCK replay runs — no
// model for seeding); each ask goes through CopilotService (access check, read-only facts, shared ledger / limits,
// click-key idempotency) and is re-authorised from that session after the model returns. Payments: never created.
//
//   Optional: --cases L3,L4,L5 (ask only these; at most one model request + one token count each).
//   Dry run (no model at all, explanation NO_MODEL) — on a COPY only:
//     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-live-acceptance.mts --db <copy>
//   Live run (only after authorisation; main DB so the spend lands in the shared ledger; dev server STOPPED):
//     TRADEPROOF_COPILOT_LIVE=on node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-live-acceptance.mts \
//       --db data/sandbox-payments.sqlite --live --authorised-cap-usd 0.20
//
// Live guards: --live, --authorised-cap-usd in (0, 0.20], TRADEPROOF_COPILOT_LIVE=on in THIS process only (nothing is
// written to .env.local; the switch ends with the process), TRADEPROOF_APPROVAL_PAYMENTS must be unset, port 3000 must
// be free. One attempt per ask (no SDK / app retry, no re-ask). Each reservation ≤ min(US$0.04, cap − reserved so far
// in this run); UNKNOWN keeps its reservation counted. Before seeding: a consistent backup (VACUUM INTO) and a ledger
// snapshot; afterwards the ledger diff. Evidence (Git-ignored): data/live-acceptance/copilot-<mode>-<stamp>/ with one
// JSON per ask (bundle, basis, prompt, rule versions, raw model output, validation, status, usage, ledger row) and
// review.md for the person who checks each answer. Never the API key, a cookie or a session token.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import nextEnv from "@next/env";
import { COPILOT_LIMITS } from "../src/lib/copilot.ts";
import { AuthService } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { BudgetStore } from "../src/server/budget/store.ts";
import { CopilotService, type CopilotEvidence } from "../src/server/copilot/service.ts";
import { seedAcceptanceCases } from "../tests/helpers/copilot-fixtures.ts";
import { openWorld } from "./copilot-world.mts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const dbArg = arg("--db");
const live = process.argv.includes("--live");
const capUsd = Number(arg("--authorised-cap-usd") ?? "0");
if (!dbArg) throw new Error("--db <file> is required");
const db = resolve(dbArg);
const mainDb = resolve("data", "sandbox-payments.sqlite");

const portFree = () =>
  new Promise<boolean>((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(3000, "127.0.0.1", () => s.close(() => ok(true)));
  });

if (live) {
  if (!(capUsd > 0 && capUsd <= 0.2)) throw new Error("--authorised-cap-usd must be > 0 and ≤ 0.20 (the owner-authorised cap)");
  nextEnv.loadEnvConfig(process.cwd()); // the same loader as `next dev`; values are never printed
  if ((process.env.TRADEPROOF_COPILOT_LIVE ?? "") !== "on") throw new Error("TRADEPROOF_COPILOT_LIVE=on is required for a live run");
  if ((process.env.TRADEPROOF_APPROVAL_PAYMENTS ?? "").trim() !== "") throw new Error("TRADEPROOF_APPROVAL_PAYMENTS must be unset for this run");
  if (!(await portFree())) throw new Error("port 3000 is in use: stop the dev server first (no second writer during the run)");
  if (db.toLowerCase() !== mainDb.toLowerCase()) console.warn("NOTE: live run on a file other than the main DB — the spend will NOT be in the shared ledger.");
} else {
  if (db.toLowerCase() === mainDb.toLowerCase()) throw new Error("a dry run is for a COPY only");
  process.env.AI_PROVIDER = ""; // dry run: never a model, whatever the environment says
  process.env.TRADEPROOF_COPILOT_LIVE = "";
}
const capMicros = Math.round(capUsd * 1e6);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(process.cwd(), "data", "live-acceptance", `copilot-${live ? "live" : "dry"}-${stamp}`);
mkdirSync(outDir, { recursive: true });

// ---------- before: consistent backup + ledger snapshot ----------
const ledgerRows = () => {
  const c = new DatabaseSync(db, { readOnly: true });
  try {
    return c.prepare("SELECT id, request_key, purpose, state, reserved_micros, settled_micros, input_tokens, output_tokens, budget_day FROM ai_budget_ledger ORDER BY reserved_at, id").all() as Record<string, unknown>[];
  } finally {
    c.close();
  }
};
if (live) {
  const backup = join(resolve("data", "backups"), `sandbox-payments.sqlite.before-copilot-live.${stamp}.sqlite`);
  mkdirSync(resolve("data", "backups"), { recursive: true });
  const ro = new DatabaseSync(db, { readOnly: true });
  ro.prepare("VACUUM INTO ?").run(backup);
  ro.close();
  console.log(`backup (consistent, VACUUM INTO): ${backup}`);
}
const ledgerBefore = ledgerRows();

// ---------- dedicated [TEST] buyer, real sign-in ----------
const authStore = new AuthStore(db);
const auth = new AuthService(authStore);
const tag = randomBytes(3).toString("hex");
const username = `copilot-run-${tag}`;
const password = randomBytes(18).toString("base64url"); // memory only
if ((await auth.createAccount(username, "BUYER", `[TEST] Copilot acceptance ${tag}`, password)) !== "CREATED") throw new Error("could not create the run account");
const login = await auth.login(username, password, null);
if (login.status !== "OK") throw new Error(`sign-in failed: ${login.status}`);
const token = login.token;
const owner = login.principal;

const w = openWorld(db, { approverAssigned: (id) => auth.approverState(id).some((a) => a.assigned) });
const ledger = new BudgetStore(db);
const evidence: CopilotEvidence[] = [];
const runKeys = new Set<string>();
const reservedInRun = () => [...runKeys].reduce((sum, k) => sum + (ledger.byRequestKey(k)?.reservedMicros ?? 0), 0);
const copilot = new CopilotService(w.src, {
  budget: ledger,
  liveEnabled: () => live,
  runCapMicros: () => (live ? Math.max(0, capMicros - reservedInRun()) : null),
  onEvidence: (e) => {
    evidence.push(e);
    if (e.ledgerKey) runKeys.add(e.ledgerKey);
  },
});

const results: Record<string, unknown>[] = [];
// Read before the ledger connection closes (2 Nov fix: the first live run crashed here after all six calls had completed).
let reservedTotal = 0;
try {
  const cases = await seedAcceptanceCases(w, `${live ? "live" : "dry"} ${stamp}`, { principal: owner, ownerId: owner.id });
  // --cases L3,L4,L5 asks only those (the other records are still seeded, unasked: same fixtures, nothing sent for them).
  const only = (arg("--cases") ?? "").split(",").filter(Boolean);
  if (only.some((x) => !cases.some((c) => c.id === x))) throw new Error(`--cases must name L1..L6`);
  for (const c of cases.filter((x) => only.length === 0 || only.includes(x.id))) {
    const n = evidence.length;
    const key = randomUUID();
    const res = await copilot.ask(owner, c.requestId, { seriesId: c.seriesId, versionId: c.versionId, runId: null, baseRunId: null }, c.intent, key, `acceptance-${c.id}`, () => auth.resolve(token));
    const ev = evidence[n] ?? null;
    const row = ev?.ledgerKey ? ledger.byRequestKey(ev.ledgerKey) : null;
    const answer = res.status === "OK" ? res.answer : null;
    const record = {
      case: c,
      clickKey: key,
      httpEquivalentStatus: res.status,
      answerStatus: answer?.status ?? null,
      explanation: answer?.explanation ?? null,
      evidence: ev,
      ledgerRow: row,
      review: { file: "review.md", section: c.id, note: "A citation that exists and numbers that pass the check do NOT prove the explanation is right; a person reads it against the facts and the pages." },
    };
    results.push(record);
    writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(record, null, 1));
    const e = answer?.explanation;
    console.log(
      `${c.id} ${c.intent}: ${res.status} · ${e ? (e.kind === "NONE" ? `NONE ${e.reason}${e.detail ? ` (${e.detail.slice(0, 80)})` : ""}` : `${e.kind} ${e.sentences.length} sentences`) : "-"} · bundle ${ev?.prompt?.bundleChars ?? "-"} chars · tokens counted ${ev?.tokenCount ?? "-"} · ledger ${row ? `${row.state} reserved ${row.reservedMicros} settled ${row.settledMicros ?? "-"} in ${row.inputTokens ?? "-"} out ${row.outputTokens ?? "-"}` : "none"}`,
    );
  }
} finally {
  reservedTotal = reservedInRun();
  auth.logout(token);
  w.close();
  ledger.close();
  authStore.close();
}

const ledgerAfter = ledgerRows();
const beforeIds = new Set(ledgerBefore.map((r) => String(r.id)));
const added = ledgerAfter.filter((r) => !beforeIds.has(String(r.id)));
const changed = ledgerAfter.filter((r) => beforeIds.has(String(r.id)) && JSON.stringify(r) !== JSON.stringify(ledgerBefore.find((b) => b.id === r.id)));
const summary = {
  live,
  capUsd,
  perAskCapUsd: COPILOT_LIMITS.maxReservedMicros / 1e6,
  db,
  account: username,
  calls: { complete: copilot.calls.complete, tokenCount: copilot.calls.count },
  reservedInRunMicros: reservedTotal,
  ledger: { before: ledgerBefore.length, after: ledgerAfter.length, added, changedExistingRows: changed.length },
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
writeFileSync(
  join(outDir, "review.md"),
  [
    `# Copilot acceptance review — ${live ? "LIVE" : "DRY RUN (no model)"} ${stamp}`,
    "",
    "For each case: read the explanation sentence by sentence against the cited facts (in the case JSON) and the record's pages.",
    "Passing TradeProof's checks (citations exist, numbers / states backed) does not prove the explanation is right.",
    "",
    ...results.flatMap((r) => {
      const c = r.case as { id: string; intent: string; fixture: string };
      return [`## ${c.id} — ${c.fixture} · ${c.intent}`, "", `- Evidence: ${c.id}.json`, "- Correct and complete? (yes / no — why):", "- Anything stated that the facts do not say?:", "- Reviewer / date:", ""];
    }),
  ].join("\n"),
);
console.log(JSON.stringify(summary.calls), `reserved in run ${summary.reservedInRunMicros} µUSD; ledger rows ${ledgerBefore.length} → ${ledgerAfter.length}; existing rows changed: ${changed.length}`);
console.log(`evidence (Git-ignored): ${outDir}`);
