// Safe local MOCK mode (3 Nov 2026). One entry point that always runs TradeProof on a SEPARATE MOCK database with
// MOCK extraction, MOCK Copilot answers and MOCK PayPal — no model, token-count or PayPal request is possible.
//
//   npm run mock:check            show how the app would resolve its configuration (states only, never values)
//   npm run mock:accounts         create buyer-a / buyer-b / approver in the MOCK database (hidden password input)
//   npm run mock:reset-password   change the password of an existing account in the MOCK database (hidden input)
//   npm run mock:seed             REHEARSAL ONLY: one demo record prepared by a script up to "approver assigned"
//                                 (value reviews are written by the script, not by a person)
//   npm run mock:seed-base        RECORDING BASE: the demo request + quote v1 + one MOCK run, nothing reviewed
//   npm run mock:start            start the dev server on http://127.0.0.1:3000 (Ctrl+C stops it)
//   npm run mock:close            after the server has stopped: checkpoint and close the MOCK database cleanly
//
// PowerShell: use npm.cmd instead of npm (e.g. `npm.cmd run mock:start`).
//
// Database: TRADEPROOF_MOCK_DB (a path) or, by default, data/mock/tradeproof-mock.sqlite. It is created on first use.
// The main database data/sandbox-payments.sqlite is REFUSED, and so is a TRADEPROOF_DB_PATH that names another file
// (no silent fallback). The process environment set here wins over .env.local, so keys in .env.local are never used.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const PORT = 3000;
const MAIN_DB = resolve(root, "data", "sandbox-payments.sqlite");
const DEFAULT_MOCK_DB = resolve(root, "data", "mock", "tradeproof-mock.sqlite");
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

function fail(message) {
  console.error(`\nREFUSED: ${message}\n`);
  process.exit(2);
}

if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "src", "server", "db", "location.ts"))) {
  fail("run this from the TradeProof project folder (npm run mock:…).");
}

const mockDb = resolve(root, (process.env.TRADEPROOF_MOCK_DB ?? "").trim() || DEFAULT_MOCK_DB);
if (same(mockDb, MAIN_DB)) fail("TRADEPROOF_MOCK_DB points at the main database data/sandbox-payments.sqlite. MOCK mode never uses it.");
const preset = (process.env.TRADEPROOF_DB_PATH ?? "").trim();
if (preset && !same(preset, mockDb)) {
  fail(`TRADEPROOF_DB_PATH is set in this terminal to another file. Remove it (PowerShell: Remove-Item Env:TRADEPROOF_DB_PATH; Git Bash: unset TRADEPROOF_DB_PATH) or use TRADEPROOF_MOCK_DB instead.`);
}

/** The forced environment. A single space counts as "set" for Next's .env loader (so .env.local cannot fill it) and as empty for the app. */
const BLANK = " ";
function mockEnv() {
  const env = { ...process.env };
  Object.assign(env, {
    TRADEPROOF_DB_PATH: mockDb,
    AI_PROVIDER: "mock",
    AI_MODEL: BLANK,
    AI_API_KEY: BLANK,
    ANTHROPIC_API_KEY: BLANK,
    AI_BUDGET_APPROVED: BLANK,
    TRADEPROOF_COPILOT_LIVE: "off",
    TRADEPROOF_APPROVAL_PAYMENTS: "mock",
    PAYPAL_CLIENT_ID: BLANK,
    PAYPAL_CLIENT_SECRET: BLANK,
    PAYPAL_EXPECTED_PAYEE_MERCHANT_ID: BLANK,
    PAYPAL_WEBHOOK_ID: BLANK,
  });
  return env;
}

/** Runs the app's own resolvers (same .env loader as next dev) under the forced environment and checks every state. */
function check({ quiet = false } = {}) {
  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(root, "scripts", "copilot-config-check.mts")], {
    cwd: root,
    env: mockEnv(),
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`configuration check could not run:\n${r.stderr}`);
  const s = JSON.parse(r.stdout);
  const problems = [];
  if (s.extractionModel !== "READY MOCK (mock)") problems.push(`extraction is "${s.extractionModel}", expected "READY MOCK (mock)"`);
  if (s.copilotLiveSwitch !== "off") problems.push(`Copilot live switch is ${s.copilotLiveSwitch}, expected off`);
  if (s.approvalPayments !== "MOCK") problems.push(`approval payments are ${s.approvalPayments}, expected MOCK`);
  if (s.database === "MAIN DB") problems.push("the app would open the MAIN database");
  if (problems.length) fail(`MOCK mode is not safe:\n - ${problems.join("\n - ")}`);
  if (!quiet) {
    console.log("TradeProof MOCK mode — configuration check passed");
    console.log(`  database            : ${mockDb}${existsSync(mockDb) ? "" : " (not created yet)"}`);
    console.log(`  extraction          : ${s.extractionModel} — canned SYNTHETIC output, no AI call`);
    console.log(`  Copilot real model  : ${s.copilotLiveSwitch} — answers are MOCK`);
    console.log(`  approval payments   : ${s.approvalPayments} — simulated PayPal, no network`);
    console.log(`  .env files seen     : ${s.envFiles.length ? s.envFiles.join(", ") + " (values overridden above)" : "none"}`);
  }
  return s;
}

function portInUse(port) {
  return new Promise((done) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("error", () => done(false));
  });
}

function run(script, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(root, "scripts", script), ...args], {
    cwd: root,
    env: { ...mockEnv(), ...extraEnv },
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "check":
    check();
    break;

  case "accounts":
  case "reset-password": {
    check({ quiet: true });
    mkdirSync(dirname(mockDb), { recursive: true });
    console.log(`MOCK database: ${mockDb}`);
    run(cmd === "accounts" ? "setup-accounts.mjs" : "reset-password.mjs");
    break;
  }

  case "seed": {
    check({ quiet: true });
    if (!existsSync(mockDb)) fail("the MOCK database does not exist yet — run npm run mock:accounts first.");
    console.log("REHEARSAL ONLY: the script writes the value reviews, answers and classifications as the buyer.");
    console.log("They are not a person's review. Do not use this record for a recorded demo.\n");
    run("seed-demo-walkthrough.mts", rest, { SEED_DB: mockDb });
    break;
  }

  case "seed-base": {
    check({ quiet: true });
    if (!existsSync(mockDb)) fail("the MOCK database does not exist yet — run npm run mock:accounts first.");
    run("seed-recording-base.mts", rest, { SEED_DB: mockDb });
    break;
  }

  case "start": {
    check();
    if (await portInUse(PORT)) fail(`port ${PORT} is already in use on 127.0.0.1 — stop the other server first.`);
    mkdirSync(dirname(mockDb), { recursive: true });
    if (!existsSync(mockDb)) console.log("\nNote: no MOCK database yet — sign-in needs accounts (npm run mock:accounts).");
    // A dev cache built against another database can make pages reload in a loop: clear it when the database changes.
    const marker = join(root, ".next", "tradeproof-db.txt");
    const last = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
    if (existsSync(join(root, ".next")) && last !== mockDb) {
      rmSync(join(root, ".next"), { recursive: true, force: true });
      console.log("Cleared .next (it was built for another database or another mode).");
    }
    const next = join(root, "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(next)) fail("dependencies are not installed — run npm ci first.");
    console.log(`\nStarting http://127.0.0.1:${PORT} (MOCK). Stop with Ctrl+C, then run npm run mock:close.\n`);
    const child = spawn(process.execPath, [next, "dev", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: root, env: mockEnv(), stdio: "inherit" });
    const writeMarker = setInterval(() => {
      if (existsSync(join(root, ".next"))) {
        try { writeFileSync(marker, mockDb); clearInterval(writeMarker); } catch { /* retry */ }
      }
    }, 1000);
    process.on("SIGINT", () => {}); // Ctrl+C reaches the dev server directly; wait for it to exit.
    child.on("exit", (code) => {
      clearInterval(writeMarker);
      console.log(`\nDev server stopped (exit ${code ?? "signal"}). Run npm run mock:close to checkpoint the MOCK database.`);
      process.exit(0);
    });
    break;
  }

  case "close": {
    if (!existsSync(mockDb)) fail(`no MOCK database at ${mockDb}.`);
    if (await portInUse(PORT)) fail(`port ${PORT} is still in use — stop the dev server (Ctrl+C) first.`);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(mockDb);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const [cp] = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
      const [qc] = db.prepare("PRAGMA quick_check").all();
      if (cp.busy !== 0) fail("the database is still in use by another process; nothing was changed.");
      console.log(`MOCK database checkpointed and closed: ${mockDb} (quick_check ${qc.quick_check}).`);
    } finally {
      db.close();
    }
    break;
  }

  default:
    console.log("Usage: npm run mock:check | mock:accounts | mock:reset-password | mock:seed | mock:seed-base | mock:start | mock:close");
    process.exit(cmd ? 2 : 0);
}
