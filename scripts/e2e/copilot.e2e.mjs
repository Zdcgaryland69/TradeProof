// Browser check of the Copilot panel (2 Nov; MOCK only). Manual run, not part of `npm test`. Works ONLY on a database
// COPY (E2E_DB); the dev server must run on the same copy with AI_PROVIDER=mock (MOCK explanations, labelled "not AI"),
// TRADEPROOF_DB_PATH=<copy>, payment switch MOCK (5 Nov: start it with npm run mock:start, TRADEPROOF_MOCK_DB=<copy>) and
// TRADEPROOF_COPILOT_LIVE off. Creates its own e2e accounts in the
// copy and seeds NEW [TEST] SYNTHETIC records (MOCK replay runs). No model, token-count or PayPal request.
//
//   E2E_DB=<copy> HEADLESS=1 node scripts/e2e/copilot.e2e.mjs
//
// Checks: panel + mode label; five buttons; WHY_NOT_APPROVABLE on B (both blocks), PAYMENT_AMOUNT on C (USD 12.00,
// unknown / unverified kept apart), MOCK label, facts layer "not AI", citations resolve, supplier text collapsed; double
// click → one POST; basis change → OUTDATED on focus (no POST); approver removed → cleared on focus; another account
// signed in → cleared; sign-out clears before the request; reload starts empty; no storage; no other host; ledger and
// business tables unchanged by asking.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession, login, principalOf, signInBrowser } from "./lib/e2e-auth.mjs";
import { seedApprovalSet } from "./seed-approval.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const TABLES = ["procurement_requests", "procurement_request_revisions", "quote_versions", "quote_extraction_runs", "quote_extraction_reviews", "clarification_drafts", "clarification_draft_revisions", "supplier_replies", "clarification_replies", "clarification_answers", "approvals", "approval_events", "approval_payments", "approver_grants", "sandbox_payment_records", "sandbox_payment_events", "ai_budget_ledger"];
const counts = () => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map((t) => [t, Number(c.prepare(`SELECT count(*) AS n FROM ${t}`).get().n)]));
  } finally {
    c.close();
  }
};
mkdirSync(SHOTS, { recursive: true });

async function openTab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let seq = 0;
  const waiting = new Map();
  const tab = { requests: [], errors: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      const r = msg.params.request;
      if (r.method !== "GET" || !r.url.startsWith(BASE)) tab.requests.push(`${r.method} ${r.url}`);
    }
    if (msg.method === "Network.webSocketCreated") tab.requests.push(`WS ${msg.params.url}`);
    if (msg.method === "Runtime.exceptionThrown") tab.errors.push(msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") tab.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++seq, { resolve, reject });
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
      throw new Error(`timeout: ${expression.slice(0, 160)}`);
    },
    async goto(url, readyExpression) {
      await send("Page.bringToFront");
      await send("Page.navigate", { url });
      await tab.waitFor(`document.readyState === "complete" && (${readyExpression})`);
    },
    async click(expression) {
      await send("Page.bringToFront");
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: r.top >= 0 && r.bottom <= innerHeight && (e === hit || e.contains(hit)) }; })()`);
      if (!box?.ok) throw new Error(`not clickable on screen: ${expression.slice(0, 140)}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
    async setText(expression, value) {
      await evaluate(
        `(() => { const e = ${expression}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
      );
    },
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    },
  });
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  return tab;
}

const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const text = (css) => `(${sel(css)}?.innerText ?? "")`;
const PANEL = '[data-testid="copilot-panel"]';
const ANSWER = '[data-testid="copilot-answer"]';
const reactReady = (css) => `(() => { const e = document.querySelector(${JSON.stringify(css)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`;
const posts = (tab, from) => tab.requests.slice(from).filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !/\/_next\//.test(r));
const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
const external = (reqs) => reqs.map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !LOCAL.some((l) => u.startsWith(l)));
const facts = () => T.evaluate(`[...document.querySelectorAll('[data-testid="copilot-facts"] li')].map((li) => li.innerText).join("\\n")`);
const focus = () => T.evaluate(`(() => { window.dispatchEvent(new Event("focus")); return true; })()`);
const ready = `${reactReady(PANEL)} && ${sel(PANEL)}.dataset.mode === "MOCK"`;
const ask = async (intent) => {
  await T.click(sel(`[data-testid="copilot-ask-${intent}"]`));
  await T.waitFor(`${sel(ANSWER)}?.dataset.intent === ${JSON.stringify(intent)} || !!${sel('[data-testid="copilot-error"]')}`);
};

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-copilot-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
let T;
let edge = null;
try {
  const SESSION = await e2eSession(DB, BASE, null);
  const APPROVER = await login(BASE, { username: SESSION.accounts.approver.username, password: SESSION.passwords.approver });
  const approverId = SESSION.accounts.approver.id;
  process.env.SEED_DB = DB;
  const owner = await principalOf(DB, SESSION.account.username);
  let set;
  try {
    set = (await seedApprovalSet("e2e copilot", BASE, ["A", "B", "C"], { principal: owner.principal, id: owner.principal.id })).cases;
  } finally {
    owner.close();
  }
  const quotesUrl = (c) => `${BASE}/procurements/${c.requestId}/quotes?series=${c.seriesId}&version=${c.versionId}`;
  const grant = (action) =>
    authedFetch(BASE, SESSION, `/api/procurements/${set.A.requestId}/approvers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approverId, action }) }).then((res) => res.status);
  const c0 = counts();

  edge = spawn(EDGE, args, { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  await signInBrowser(PORT, BASE, SESSION);
  T = await openTab();

  // ---------- 1. B: WHY_NOT_APPROVABLE ----------
  await T.goto(quotesUrl(set.B), ready);
  check(
    "panel: MOCK label ('not AI'), exactly five question buttons, no text input",
    (await T.evaluate(text('[data-testid="copilot-mode"]'))).includes("not AI") &&
      (await T.evaluate(`document.querySelectorAll('[data-testid^="copilot-ask-"]').length`)) === 5 &&
      (await T.evaluate(`${sel(PANEL)}.querySelectorAll("input, textarea").length`)) === 0,
  );
  let r = T.requests.length;
  await ask("WHY_NOT_APPROVABLE");
  const fb = await facts();
  check("B: facts layer lists BLOCKED with QTY_DIFFERS and TOTAL_DIFFERS_FROM_LINES", /BLOCKED/.test(fb) && fb.includes("QTY_DIFFERS") && fb.includes("TOTAL_DIFFERS_FROM_LINES"), fb.slice(0, 200));
  check("B: explanation labelled 'MOCK — canned test output, not AI'; answer CURRENT", (await T.evaluate(text('[data-testid="copilot-explanation-label"]'))).startsWith("MOCK") && (await T.evaluate(`${sel(ANSWER)}.dataset.status`)) === "CURRENT");
  check("B: every citation [Fn] points to a fact shown in the panel", await T.evaluate(`[...document.querySelectorAll('[data-testid="copilot-sentences"] a')].every((a) => !!document.getElementById(a.getAttribute("href").slice(1)))`));
  check("B: exactly one write request (the ask POST)", posts(T, r).length === 1 && /\/copilot$/.test(posts(T, r)[0]), posts(T, r).join(" | "));
  await T.shot("02nov-copilot-01-why-not-B");

  // ---------- 2. C: PAYMENT_AMOUNT ----------
  await T.goto(quotesUrl(set.C), ready);
  await ask("PAYMENT_AMOUNT");
  const fc = await facts();
  // 5 Nov: this check runs with the server's approval-payment switch on MOCK (since facts .7 the fact names MOCK vs Sandbox by
  // that switch). The mode is checked on its own first, from the page's payment badge (server-rendered switch value).
  const payEnv = await T.evaluate(text('[data-testid="decision-pay-env"]'));
  check("C: precondition — this server's approval-payment switch is MOCK (payment badge)", payEnv.startsWith("Payments: MOCK"), payEnv);
  const amountLine = fc.split(/\r?\n/).find((l) => l.includes("Proposed amount for a")) ?? "";
  check("C: proposed amount for a MOCK payment USD 12.00 (no valid approval), not called Sandbox; unknown and unverified costs listed apart; landed cost not calculated", fc.includes("Proposed amount for a MOCK payment (simulated PayPal) (the quote amount): USD 12.00") && !fc.includes("Proposed amount for a Sandbox payment") && fc.includes("Unknown cost") && fc.includes("Unverified estimate") && fc.includes("Landed cost"), amountLine.slice(0, 200));
  check(
    "C: supplier text collapsed and labelled 'data only'",
    (await T.evaluate(`document.querySelectorAll('[data-testid="copilot-supplier-text"]').length`)) === 1 && (await T.evaluate(`[...document.querySelectorAll('[data-testid="copilot-supplier-text"]')].every((d) => !d.open && d.innerText.includes("data only"))`)),
  );
  await T.shot("02nov-copilot-02-payment-C");

  // ---------- 2b. fixed server notice "answered ≠ approved" (2 Nov): shown on "still open", not on the payment answer ----------
  check("C payment answer: no fixed notice", (await T.evaluate(`document.querySelectorAll('[data-testid="copilot-notice"]').length`)) === 0);
  await ask("AFTER_REPLY");
  const notice = await T.evaluate(`[...document.querySelectorAll('[data-testid="copilot-notice"]')].map((n) => n.innerText).join(" | ")`);
  check(
    "C 'What is still open…': fixed notice 'a question marked answered … does not approve any term' visible in the not-AI layer",
    notice.includes("a question marked answered records the supplier's reply; it does not approve any term") && (await T.evaluate(`(() => { const n = document.querySelector('[data-testid="copilot-notice"]'); const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"; })()`)),
    notice.slice(0, 200),
  );
  await T.shot("02nov-copilot-05-fixed-notice");

  // ---------- 3. double click → one POST ----------
  r = T.requests.length;
  await T.evaluate(`(() => { const b = ${sel('[data-testid="copilot-ask-NEXT_STEP"]')}; b.click(); b.click(); return true; })()`);
  await T.waitFor(`${sel(ANSWER)}?.dataset.intent === "NEXT_STEP"`);
  check("double click → one POST", posts(T, r).length === 1, posts(T, r).join(" | "));

  // ---------- 4. basis change → OUTDATED on focus, no POST ----------
  const { ProcurementStore } = await import(pathToFileURL(join(process.cwd(), "src/server/procurement/store.ts")).href);
  const { recordToInput } = await import(pathToFileURL(join(process.cwd(), "src/lib/procurement.ts")).href);
  const { validateProcurementInput } = await import(pathToFileURL(join(process.cwd(), "src/server/procurement/validate.ts")).href);
  const ps = new ProcurementStore(DB);
  try {
    const rec = ps.get(set.C.requestId);
    const input = recordToInput(rec);
    input.additionalRequirements = "[SYNTHETIC] edited by copilot.e2e to change the basis";
    const v = validateProcurementInput(input, "update");
    check("copy: request C edited (new revision) outside the panel", v.ok && ps.update(rec.id, rec.revision, v.value).status === "UPDATED");
  } finally {
    ps.close();
  }
  r = T.requests.length;
  await focus();
  await T.waitFor(`${sel(ANSWER)}?.dataset.status === "OUTDATED"`);
  check("focus → 'Based on an earlier state (request changed …)'; no POST, no re-ask", (await T.evaluate(text('[data-testid="copilot-outdated"]'))).includes("request changed") && posts(T, r).length === 0);
  await T.shot("02nov-copilot-03-outdated");
  check("nothing in localStorage / sessionStorage", (await T.evaluate("localStorage.length + sessionStorage.length")) === 0);
  await T.goto(quotesUrl(set.C), ready);
  check("reload starts empty (answers are not stored)", !(await T.evaluate(`!!${sel(ANSWER)}`)));

  // ---------- 5. approver removed → cleared on focus ----------
  check("owner assigns the approver on A (API)", (await grant("GRANT")) === 200);
  await signInBrowser(PORT, BASE, APPROVER);
  await T.goto(quotesUrl(set.A), ready);
  await ask("WHY_NOT_APPROVABLE");
  check("approver: answer shows the approver role", (await facts()).includes("You are the approver assigned"));
  check("owner removes the approver (API)", (await grant("REVOKE")) === 200);
  await focus();
  await T.waitFor(`${sel('[data-testid="copilot-gone"]')}?.dataset.gone === "NO_ACCESS"`);
  check("focus → 'You can no longer view this record', answer cleared", !(await T.evaluate(`!!${sel(ANSWER)}`)));
  await T.shot("02nov-copilot-04-no-access");

  // ---------- 6. another account signed in → cleared ----------
  check("owner assigns the approver again (API)", (await grant("GRANT")) === 200);
  await T.goto(quotesUrl(set.A), ready);
  await ask("NEXT_STEP");
  const acct = await T.evaluate(`${sel(PANEL)}.dataset.account`);
  await signInBrowser(PORT, BASE, SESSION);
  await focus();
  await T.waitFor(`${sel('[data-testid="copilot-gone"]')}?.dataset.gone === "OTHER_ACCOUNT"`);
  check("another account signed in → 'Another account is signed in', answer cleared", !(await T.evaluate(`!!${sel(ANSWER)}`)) && (await T.evaluate(`${sel(PANEL)}.dataset.account`)) !== acct);

  // ---------- 7. sign-out event clears; sign-out leads to /login ----------
  await T.goto(quotesUrl(set.A), ready);
  await ask("NEXT_STEP");
  await T.evaluate(`(() => { window.dispatchEvent(new Event("tradeproof:signing-out")); return true; })()`);
  await T.waitFor(`${sel('[data-testid="copilot-gone"]')}?.dataset.gone === "SIGNED_OUT"`);
  check("the sign-out event (sent by Sign out before its request) clears the answer", !(await T.evaluate(`!!${sel(ANSWER)}`)));
  await ask("NEXT_STEP");
  await T.click(sel('[data-testid="sign-out"]'));
  await T.waitFor(`location.pathname === "/login"`);
  check("Sign out → /login; storage empty", (await T.evaluate("localStorage.length + sessionStorage.length")) === 0);

  check("no console errors", T.errors.length === 0, T.errors.join(" | ").slice(0, 600));
  const ext = external(T.requests);
  check("no request to any other host", ext.length === 0, ext.join(" | ").slice(0, 300));
  const c1 = counts();
  const expected = { ...c0, procurement_request_revisions: c0.procurement_request_revisions + 1, approver_grants: c0.approver_grants + 3 };
  const diff = TABLES.filter((t) => c1[t] !== expected[t]);
  check("asking wrote nothing: ledger, approvals, events, payments, drafts, replies, answers, runs, reviews unchanged (only this script's edit + 3 grants)", diff.length === 0, diff.map((t) => `${t} ${c0[t]}→${c1[t]}`).join(", "));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  T?.close();
  edge?.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Edge may still hold the profile briefly
  }
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
