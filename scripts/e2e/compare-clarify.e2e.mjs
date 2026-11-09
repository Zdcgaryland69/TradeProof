// Browser check of the comparison page and creating a clarification draft from it, under sign-in (30 Oct; manual run,
// not part of `npm test`). Self-seeding replacement for the 26–27 Oct comparison / clarification checks, which worked
// on historical records that have no owner since access control (and stay unassigned by the owner's decision).
//
//   E2E_DB=<copy> node scripts/e2e/compare-clarify.e2e.mjs        (dev server: TRADEPROOF_DB_PATH=<same copy>)
//
// Seeds approval case B (quantity 18 vs 20, total ≠ lines; one MOCK replay run, reviewed) owned by this run's e2e
// buyer, assigns the e2e approver, then uses THREE separate Edge processes (buyer, approver, second buyer):
//   buyer: comparison shows the basis, the MOCK run, differences and questions; "Create draft" opens a draft with
//          questions; pressing it again opens the same draft (one row);
//   approver (assigned): reads the comparison and the draft, has no way to create one (API 404, nothing written);
//   second buyer: the comparison URL → 404.
// No model, token-count or PayPal request. HEADLESS=1 for headless.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { e2eDb, e2eSession, grantApprover, login, principalOf, signInBrowser } from "./lib/e2e-auth.mjs";
import { seedApprovalSet } from "./seed-approval.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const count = (sql, ...p) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return Number(c.prepare(sql).get(...p).n);
  } finally {
    c.close();
  }
};

const edges = [];
const profiles = [];
async function browser(name, session) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), `tradeproof-e2e-cc-${name}-`));
  profiles.push(profile);
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,900", "about:blank"];
  if (process.env.HEADLESS === "1") args.unshift("--headless=new");
  edges.push(spawn(EDGE, args, { stdio: "ignore" }));
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  await signInBrowser(port, BASE, session);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let seq = 0;
  const waiting = new Map();
  const tab = { name, requests: [], errors: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") tab.requests.push(`${msg.params.request.method} ${msg.params.request.url}`);
    if (msg.method === "Runtime.exceptionThrown") tab.errors.push(msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") tab.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      waiting.set(++seq, { res, rej });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression.slice(0, 100)}`);
    return r.result.value;
  };
  Object.assign(tab, {
    send,
    evaluate,
    close: () => ws.close(),
    async waitFor(expression, timeout = 30000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expression).catch(() => false)) return;
        await sleep(150);
      }
      throw new Error(`[${name}] timeout: ${expression.slice(0, 160)}`);
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await tab.waitFor(`document.readyState === "complete"`);
      await sleep(300);
    },
    async click(expression) {
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error(`[${name}] not found: ${expression.slice(0, 140)}`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
  });
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  return tab;
}
const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const hydrated = (t, css) => t.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(css)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`);
const is404 = (t) => t.evaluate(`document.title.includes("404") || document.body.innerText.includes("could not be found")`);

let tb, ta, t2;
try {
  const SESSION = await e2eSession(DB, BASE, null);
  const APPROVER = await login(BASE, { username: SESSION.accounts.approver.username, password: SESSION.passwords.approver });
  const OTHER = await login(BASE, { username: SESSION.accounts.buyer2.username, password: SESSION.passwords.buyer2 });
  process.env.SEED_DB = DB;
  const owner = await principalOf(DB, SESSION.account.username);
  let c;
  try {
    c = (await seedApprovalSet("e2e compare-clarify", BASE, ["B"], { principal: owner.principal, id: owner.principal.id })).cases.B;
  } finally {
    owner.close();
  }
  await grantApprover(BASE, SESSION, c.requestId, SESSION.accounts.approver.id);
  const drafts0 = count("SELECT count(*) AS n FROM clarification_drafts WHERE request_id = ?", c.requestId);

  [tb, ta, t2] = await Promise.all([browser("buyer", SESSION), browser("approver", APPROVER), browser("buyer2", OTHER)]);

  await tb.goto(c.compareUrl);
  await hydrated(tb, '[data-testid="create-draft"]');
  const diffs = await tb.evaluate(`Number((${sel('[data-testid="count-differences"]')}?.innerText.match(/\\d+/) || [0])[0])`);
  const questions = await tb.evaluate(`document.querySelectorAll('[data-testid="compare-questions"] [data-question]').length`);
  check("buyer: comparison shows its basis, the MOCK run label, differences and questions", (await tb.evaluate(`!!${sel('[data-testid="compare-basis"]')} && !!${sel('[data-testid="mock-run"]')}`)) && diffs > 0 && questions > 0, `differences ${diffs}, questions ${questions}`);
  await tb.click(sel('[data-testid="create-draft"]'));
  await tb.waitFor(`location.pathname.includes("/quotes/drafts/") && !!${sel('[data-testid="draft-questions"]')}`);
  const draftPath = await tb.evaluate("location.pathname");
  const draftQs = await tb.evaluate(`document.querySelectorAll('[data-testid="draft-questions"] [data-question]').length`);
  check("buyer: Create draft opens a clarification draft with the questions", draftQs > 0 && (await tb.evaluate(`!!${sel('[data-testid="draft-banner"]')}`)), `${draftQs} questions`);
  await tb.goto(c.compareUrl);
  await hydrated(tb, '[data-testid="create-draft"]');
  await tb.click(sel('[data-testid="create-draft"]'));
  await tb.waitFor(`location.pathname.includes("/quotes/drafts/")`);
  check("buyer: pressing it again opens the same draft (one row)", (await tb.evaluate("location.pathname")) === draftPath && count("SELECT count(*) AS n FROM clarification_drafts WHERE request_id = ?", c.requestId) === drafts0 + 1);

  await ta.goto(c.compareUrl);
  check("approver (assigned): reads the comparison", !(await is404(ta)) && (await ta.evaluate(`!!${sel('[data-testid="compare-basis"]')}`)));
  await ta.goto(`${BASE}${draftPath}`);
  check("approver: reads the draft", !(await is404(ta)) && (await ta.evaluate(`!!${sel('[data-testid="draft-questions"]')}`)));
  const apCreate = await ta.evaluate(`fetch("/api/procurements/${c.requestId}/quotes/${c.seriesId}/versions/${c.versionId}/clarification-drafts", { method: "POST", headers: { "Content-Type": "application/json", "X-TradeProof-CSRF": (document.cookie.match(/tp_csrf=([^;]+)/) || [])[1] || "" }, body: JSON.stringify({ run: "${c.runId}" }) }).then((r) => r.status)`);
  check("approver: creating a draft through the API → 404; nothing written", apCreate === 404 && count("SELECT count(*) AS n FROM clarification_drafts WHERE request_id = ?", c.requestId) === drafts0 + 1, String(apCreate));

  await t2.goto(c.compareUrl);
  check("second buyer: the comparison URL → 404", await is404(t2));
  await t2.goto(`${BASE}${draftPath}`);
  check("second buyer: the draft URL → 404", await is404(t2));

  const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
  const ext = [tb, ta, t2].flatMap((t) => t.requests).map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !u.startsWith("about:") && !LOCAL.some((l) => u.startsWith(l)));
  check("no request to any other host", ext.length === 0, ext.slice(0, 3).join(" | ") || "(none)");
  const errs = [tb, ta, t2].flatMap((t) => t.errors.map((e) => `${t.name}: ${e}`)).filter((e) => !/status of 40[134]/.test(e));
  check("no console errors (expected 401 / 403 / 404 responses excluded)", errs.length === 0, errs.join(" | ").slice(0, 600));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  for (const t of [tb, ta, t2]) t?.close();
  for (const e of edges) e.kill();
  await sleep(700);
  for (const p of profiles) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Edge may still hold the profile briefly
    }
  }
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
