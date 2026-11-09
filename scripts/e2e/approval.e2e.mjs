// Browser check for the approval condition snapshot (29 Oct, schema v14; manual run, not part of `npm test`). NORMAL
// (headed) Edge, 1366x768; HEADLESS=1 for headless. Needs `npm run dev`. No model, token-count or PayPal call: the page
// and APIs never call a model, and payment steps for approvals are refused in this phase (PAYMENTS_NOT_ENABLED).
//
//   node scripts/e2e/approval.e2e.mjs
//       Seeds a NEW set of "[TEST] approval … e2e approval <time> (SYNTHETIC)" records (scripts/e2e/seed-approval.mjs)
//       and works only on them: A (allowed) from the comparison page's entry link, approve, repeated approve (no second
//       row); B blocked (quantity + total, button disabled); the original 30 % deposit sample blocked; C confirmations
//       (button disabled until each is ticked), fees outside this payment listed as unknown / unverified; edit-then-revert
//       of A's request → "No longer valid" and stays so; payment step refused; revoke C with a reason. Checks that no
//       request leaves for another host and that the ledger, LIVE runs and Sandbox payments do not change.
// Screenshots in data/e2e-screens/ (Git-ignored). State: data/e2e-approval-state.json.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { grantApprover, login, principalOf, e2eDb, e2eSession, signInBrowser } from "./lib/e2e-auth.mjs";
import { seedApprovalSet } from "./seed-approval.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // e2e buyer: owns the seeded records, assigns the approver
let APPROVER; // e2e approver: the browser is signed in as this account
const STATE = join(process.cwd(), "data", "e2e-approval-state.json");
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const counts = () => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    const n = (sql) => Number(c.prepare(sql).get().n);
    return {
      ledger: n("SELECT count(*) AS n FROM ai_budget_ledger"),
      settled: n("SELECT coalesce(sum(settled_micros), 0) AS n FROM ai_budget_ledger"),
      live: n("SELECT count(*) AS n FROM quote_extraction_runs WHERE mode = 'LIVE'"),
      mock: n("SELECT count(*) AS n FROM quote_extraction_runs WHERE mode = 'MOCK'"),
      requests: n("SELECT count(*) AS n FROM procurement_requests"),
      payments: n("SELECT count(*) AS n FROM sandbox_payment_records"),
      paymentEvents: n("SELECT count(*) AS n FROM sandbox_payment_events"),
      approvals: n("SELECT count(*) AS n FROM approvals"),
      approvalEvents: n("SELECT count(*) AS n FROM approval_events"),
      approvalPayments: n("SELECT count(*) AS n FROM approval_payments"),
    };
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
    async goto(url, readyText) {
      await send("Page.bringToFront");
      await send("Page.navigate", { url });
      await tab.waitFor(`document.readyState === "complete" && document.body.innerText.includes(${JSON.stringify(readyText)})`);
    },
    async click(expression) {
      await send("Page.bringToFront");
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: r.top >= 0 && r.bottom <= innerHeight && (e === hit || e.contains(hit)) }; })()`);
      if (!box?.ok) throw new Error(`not clickable on screen: ${expression.slice(0, 140)}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
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
const setInput = (expression, value) =>
  `(() => { const e = ${expression}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
async function hydrated(tab) {
  await tab.waitFor(`(() => { const e = document.querySelector('[data-testid="approve"]'); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`);
}
const blockCodes = () => `[...document.querySelectorAll('[data-testid="block-list"] li')].map((e) => e.dataset.code).join()`;
const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
const external = (reqs) => reqs.map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !LOCAL.some((l) => u.startsWith(l)));

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-approval-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
let A;
let edge = null;
const before = counts();
let afterSeed = before;
try {
  SESSION = await e2eSession(DB, BASE, null);
  APPROVER = await login(BASE, { username: SESSION.accounts.approver.username, password: SESSION.passwords.approver });
  process.env.SEED_DB = DB;
  const owner = await principalOf(DB, SESSION.account.username);
  let set;
  try {
    set = await seedApprovalSet("e2e approval", BASE, undefined, { principal: owner.principal, id: owner.principal.id });
  } finally {
    owner.close();
  }
  for (const c of Object.values(set.cases)) await grantApprover(BASE, SESSION, c.requestId, SESSION.accounts.approver.id);
  afterSeed = counts();
  check("seeded 4 new [TEST] SYNTHETIC records with 4 MOCK runs; no LIVE run, no budget row, no payment", afterSeed.requests === before.requests + 4 && afterSeed.mock === before.mock + 4 && afterSeed.live === before.live && afterSeed.ledger === before.ledger && afterSeed.payments === before.payments);
  writeFileSync(STATE, JSON.stringify({ createdAt: new Date().toISOString(), set }, null, 2));
  const { A: a, B: b, C: c, DEPOSIT: d } = set.cases;

  edge = spawn(EDGE, args, { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  await signInBrowser(PORT, BASE, APPROVER);
  A = await openTab();

  // A: from the comparison page's entry link.
  await A.goto(a.compareUrl, "Approval preview");
  await A.click(sel('[data-testid="approval-link"]'));
  await A.waitFor(`location.pathname.endsWith("/quotes/approval") && !!${sel('[data-testid="approval-status"]')}`);
  await hydrated(A);
  check("A: preview READY; this payment USD 12.00; landed-cost sentence; local-demo banner", (await A.evaluate(`${sel('[data-testid="approval-status"]')}.dataset.status`)) === "READY" && (await A.evaluate(text('[data-testid="this-payment"]'))) === "USD 12.00" && (await A.evaluate(`${text('[data-testid="landed-cost"]')}.includes("does not calculate the full landed cost")`)) && (await A.evaluate(`${text('[data-testid="demo-banner"]')}.includes("signed-in accounts")`)));
  await A.shot("29-approval-A-preview");
  const n0 = counts().approvals;
  await A.click(sel('[data-testid="approve"]'));
  await A.waitFor(`document.querySelector('[data-approval][data-state="ACTIVE"]') !== null`);
  check("A: approved once → one Active approval, recorded as the signed-in e2e approver", counts().approvals === n0 + 1 && (await A.evaluate(`${text('[data-testid="approval-history"]')}.includes("(approver, signed in)")`)));
  await A.goto(a.approvalUrl, "Approvals of this request");
  await A.waitFor(`!!${sel('[data-testid="approved-active"]')}`);
  // 31 Oct night: while an approval is Active the page offers no Approve button ("Approved — Active" instead); the
  // server's one-active-approval rule and request keys are checked in tests/approval.test.ts and usability.e2e.
  check("A: reloaded — 'Approved — Active' instead of the button; no second row", (await A.evaluate(`!!${sel('[data-testid="approved-active"]')}`)) && !(await A.evaluate(`!!${sel('[data-testid="approve"]')}`)) && counts().approvals === n0 + 1);
  await A.shot("29-approval-A-approved");

  // B and the original deposit sample: blocked.
  await A.goto(b.approvalUrl, "Approvals of this request");
  await hydrated(A);
  const bc = await A.evaluate(blockCodes());
  check("B: BLOCKED with QTY_DIFFERS and TOTAL_DIFFERS_FROM_LINES; Approve disabled", bc.includes("QTY_DIFFERS") && bc.includes("TOTAL_DIFFERS_FROM_LINES") && (await A.evaluate(`${sel('[data-testid="approve"]')}.disabled`)), bc);
  await A.shot("29-approval-B-blocked");
  await A.goto(d.approvalUrl, "Approvals of this request");
  await hydrated(A);
  check("original 30 % deposit sample: STAGED_PAYMENT blocks", (await A.evaluate(blockCodes())).includes("STAGED_PAYMENT"), await A.evaluate(blockCodes()));

  // C: confirmations.
  await A.goto(c.approvalUrl, "Approvals of this request");
  await hydrated(A);
  const boxes = await A.evaluate(`document.querySelectorAll('[data-confirm]').length`);
  check("C: two items to confirm (fees outside this payment); unknown and unverified lists filled; Approve disabled until ticked", boxes === 2 && (await A.evaluate(`${text('[data-testid="fees-unknown"]')}.includes("Import duties")`)) && (await A.evaluate(`${text('[data-testid="fees-unverified"]')}.includes("Forwarder")`)) && (await A.evaluate(`${sel('[data-testid="approve"]')}.disabled`)));
  await A.click(`document.querySelectorAll('[data-confirm]')[0]`);
  check("C: still disabled with one of two ticked", await A.evaluate(`${sel('[data-testid="approve"]')}.disabled`));
  await A.click(`document.querySelectorAll('[data-confirm]')[1]`);
  await A.shot("29-approval-C-confirm");
  await A.click(sel('[data-testid="approve"]'));
  await A.waitFor(`document.querySelector('[data-approval][data-state="ACTIVE"]') !== null`);
  check("C: approved after both confirmations", true);

  // Payment step refused in this phase (no record, no PayPal).
  const pay = await A.evaluate(`(async () => { const id = document.querySelector('[data-approval]').dataset.approval; const r = await fetch("/api/procurements/${c.requestId}/approvals/" + id + "/payment", { method: "POST", headers: { "X-TradeProof-CSRF": (document.cookie.match(/tp_csrf=([^;]+)/) || [])[1] || "" } }); return r.status + " " + (await r.json()).code; })()`);
  check("payment step refused: 409 PAYMENTS_NOT_ENABLED; no payment record", pay === "409 PAYMENTS_NOT_ENABLED" && counts().payments === before.payments, pay);

  // Revoke C with a reason.
  await A.evaluate(setInput(sel('[data-field="revoke-reason"]'), "e2e: revoke check (SYNTHETIC)"));
  await A.waitFor(`!${sel('[data-testid="revoke"]')}.disabled`);
  await A.click(sel('[data-testid="revoke"]'));
  await A.waitFor(`document.querySelector('[data-approval][data-state="REVOKED"]') !== null`);
  check("C: revoked with a reason → shown as Revoked", true);

  // A: edit then revert the request (through the store, as a second writer) → no longer valid, and stays so.
  const { ProcurementStore } = await import(pathToFileURL(join(process.cwd(), "src/server/procurement/store.ts")).href);
  const { validateProcurementInput } = await import(pathToFileURL(join(process.cwd(), "src/server/procurement/validate.ts")).href);
  const { recordToInput } = await import(pathToFileURL(join(process.cwd(), "src/lib/procurement.ts")).href);
  const ps = new ProcurementStore(DB);
  for (const qty of ["21", "20"]) {
    const r = ps.get(a.requestId);
    const input = recordToInput(r);
    input.items[0].quantity = qty;
    const v = validateProcurementInput(input, "update");
    ps.update(a.requestId, r.revision, v.value);
  }
  ps.close();
  await A.goto(a.approvalUrl, "Approvals of this request");
  await hydrated(A);
  check("A: after quantity 20 → 21 → 20 the approval is No longer valid (request revised), not active again", (await A.evaluate(`document.querySelector('[data-approval][data-state="INVALIDATED"]') !== null && document.querySelector('[data-approval][data-state="ACTIVE"]') === null`)) && (await A.evaluate(`${text('[data-testid="validity-reasons"]')}.includes("revert does not undo")`)));
  await A.shot("29-approval-A-invalidated");
  // The reverted request matches the quote's snapshot again, so a NEW preview is possible — but only as a new decision:
  // the old approval stays "No longer valid" and a new approval is a separate row.
  const status = await A.evaluate(`${sel('[data-testid="approval-status"]')}.dataset.status`);
  const nBefore = counts().approvals;
  await A.click(sel('[data-testid="approve"]'));
  await A.waitFor(`document.querySelectorAll('[data-approval]').length === 2`);
  check("A: a new approval after the revert is a separate row; the old one stays No longer valid", status === "READY" && counts().approvals === nBefore + 1 && (await A.evaluate(`document.querySelectorAll('[data-approval][data-state="INVALIDATED"]').length === 1 && document.querySelectorAll('[data-approval][data-state="ACTIVE"]').length === 1`)), status);

  const all = A.requests;
  const writes = all.filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r)).map((r) => r.replace(/^[A-Z]+ /, "").replace(BASE, "").replace(/[0-9a-f-]{36}/g, ":id").replace(/\?.*$/, ""));
  const allowed = [/^\/api\/procurements\/pr_:id\/approvals$/, /^\/api\/procurements\/pr_:id\/approvals\/ap_:id\/revoke$/, /^\/api\/procurements\/pr_:id\/approvals\/ap_:id\/payment$/, /^\/procurements\/pr_:id\/quotes\/approval$/];
  const unexpected = writes.filter((u) => !allowed.some((re) => re.test(u)));
  check("writes went only to approve / revoke / (refused) payment endpoints", unexpected.length === 0, unexpected.join(" | ").slice(0, 300) || "(ok)");
  check("no request to any other host", external(all).length === 0, external(all).join(" | ").slice(0, 300) || "(none)");
  check("no console errors", A.errors.length === 0, A.errors.join(" | ").slice(0, 1500));
  const after = counts();
  check("ledger, LIVE runs, MOCK runs, Sandbox payments and payment events unchanged after seeding; no approval payment", ["ledger", "settled", "live", "mock", "payments", "paymentEvents", "approvalPayments"].every((k) => after[k] === afterSeed[k]), JSON.stringify(after));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  A?.close();
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
