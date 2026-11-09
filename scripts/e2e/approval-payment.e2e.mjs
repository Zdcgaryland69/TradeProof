// Browser check of the approval → payment loop in MOCK mode (30 Oct; manual run, not part of `npm test`). Works ONLY on a
// database COPY: the dev server must run with TRADEPROOF_DB_PATH=<copy> TRADEPROOF_APPROVAL_PAYMENTS=mock, and this
// script gets the same path in E2E_DB. It refuses the main database. No model, token-count or PayPal call: the MOCK
// gateway is a JSON file next to the copy (<copy>.mock-paypal.json), and no PayPal SDK is loaded in MOCK mode.
//
//   E2E_DB=<copy> node scripts/e2e/approval-payment.e2e.mjs            seeds 3 [TEST] case-A records into the copy:
//       P (pays): approve → start (double click) → create order → simulate buyer approval → capture (double click)
//                 → PAID, one capture; reload → still PAID, no pay buttons
//       I (invalid after order): approve → start → order → buyer approval → request edited by a second writer
//                 → "No longer valid", no capture button; capture POST refused 409; record stays ORDER_CREATED
//       U (unknown): approve → start → order → buyer approval → a queued MOCK timeout → capture → CAPTURE_UNKNOWN;
//                 Check with PayPal (read-only) → still unknown; no second capture request
//   E2E_DB=<copy> node scripts/e2e/approval-payment.e2e.mjs --verify   after restarting the dev server: same states,
//       no new capture, Check on U still sends no capture
// HEADLESS=1 for headless Edge. Screenshots in data/e2e-screens/ (Git-ignored). State: <copy>.e2e-payment-state.json.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { grantApprover, login, principalOf, e2eSession, signInBrowser } from "./lib/e2e-auth.mjs";
import { seedApprovalSet } from "./seed-approval.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MAIN = resolve(process.cwd(), "data", "sandbox-payments.sqlite");
const DB = process.env.E2E_DB ? resolve(process.env.E2E_DB) : null;
if (!DB || DB.toLowerCase() === MAIN.toLowerCase() || !existsSync(DB)) {
  console.error("E2E_DB must name an existing database COPY (never data/sandbox-payments.sqlite).");
  process.exit(2);
}
const MOCKFILE = `${DB}.mock-paypal.json`;
const STATE = `${DB}.e2e-payment-state.json`;
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const VERIFY = process.argv.includes("--verify");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const mockState = () => (existsSync(MOCKFILE) ? JSON.parse(readFileSync(MOCKFILE, "utf8")) : { calls: { create: 0, get: 0, capture: 0 }, orders: {} });
const captures = () => Object.values(mockState().orders).reduce((n, o) => n + o.purchaseUnits.reduce((m, u) => m + u.captures.length, 0), 0);
const q = (sql, ...p) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return c.prepare(sql).all(...p);
  } finally {
    c.close();
  }
};
const recordsOf = (requestId) => q("SELECT p.status, p.sku, p.amount_minor, p.currency FROM approval_payments l JOIN approvals a ON a.id = l.approval_id JOIN sandbox_payment_records p ON p.id = l.payment_record_id WHERE a.request_id = ?", requestId);
mkdirSync(SHOTS, { recursive: true });

async function openTab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let seq = 0;
  const waiting = new Map();
  const tab = { requests: [], errors: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      const r = msg.params.request;
      if (r.method !== "GET" || !r.url.startsWith(BASE)) tab.requests.push(`${r.method} ${r.url}`);
    }
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
      throw new Error(`timeout: ${expression.slice(0, 160)}`);
    },
    async goto(url, readyText) {
      await send("Page.navigate", { url });
      await tab.waitFor(`document.readyState === "complete" && document.body.innerText.includes(${JSON.stringify(readyText)})`);
    },
    async click(expression, times = 1) {
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: r.top >= 0 && r.bottom <= innerHeight && (e === hit || e.contains(hit)) }; })()`);
      if (!box?.ok) throw new Error(`not clickable on screen: ${expression.slice(0, 140)}`);
      for (let i = 1; i <= times; i++) for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: i });
    },
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    },
  });
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  return tab;
}

const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const text = (css) => `(${sel(css)}?.innerText ?? "")`;
const exists = (css) => `(${sel(css)} !== null)`;
const hydrated = (tab, css) => tab.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(css)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`);
const status = (tab) => tab.evaluate(`${sel('[data-testid="payment-status"]')}?.dataset.status ?? null`);
const waitStatus = (tab, s) => tab.waitFor(`${sel('[data-testid="payment-status"]')}?.dataset.status === ${JSON.stringify(s)} && !document.querySelector('[data-testid="payment-actions"] button:disabled')`);
const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
const external = (reqs) => reqs.map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !LOCAL.some((l) => u.startsWith(l)));

let SESSION; // e2e buyer: owns the seeded records, assigns the approver, pays
let APPROVER; // e2e approver: approves
async function approveAndOrder(tab, c) {
  // The approver approves (separate account), then the same browser signs in as the buyer to pay.
  await signInBrowser(PORT, BASE, APPROVER);
  await tab.goto(c.approvalUrl, "Approvals of this request");
  await hydrated(tab, '[data-testid="approve"]');
  await tab.click(sel('[data-testid="approve"]'));
  await tab.waitFor(exists('[data-approval][data-state="ACTIVE"]'));
  await signInBrowser(PORT, BASE, SESSION);
  await tab.goto(c.approvalUrl, "Approvals of this request");
  await tab.waitFor(exists('[data-approval][data-state="ACTIVE"] [data-testid="pay-start"]'));
  await hydrated(tab, '[data-testid="pay-start"]');
  await tab.click(sel('[data-testid="pay-start"]'), 2);
  await waitStatus(tab, "NEW");
  await tab.click(sel('[data-testid="pay-order"]'));
  await waitStatus(tab, "ORDER_CREATED");
  await tab.click(sel('[data-testid="pay-mock-approve"]'));
  await tab.waitFor(`${text('[data-testid="pay-message"]')}.includes("MOCK_APPROVED")`);
}

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-pay-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,960", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
let T;
let edge = null;
try {
  edge = spawn(EDGE, args, { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  T = await openTab();

  if (!VERIFY) {
    process.env.SEED_DB = DB;
    SESSION = await e2eSession(DB, BASE, null);
    APPROVER = await login(BASE, { username: SESSION.accounts.approver.username, password: SESSION.passwords.approver });
    const owner = await principalOf(DB, SESSION.account.username);
    const o = { principal: owner.principal, id: owner.principal.id };
    let set;
    try {
      set = { P: (await seedApprovalSet("e2e pay P", BASE, ["A"], o)).cases.A, I: (await seedApprovalSet("e2e pay I", BASE, ["A"], o)).cases.A, U: (await seedApprovalSet("e2e pay U", BASE, ["A"], o)).cases.A };
    } finally {
      owner.close();
    }
    for (const c of Object.values(set)) await grantApprover(BASE, SESSION, c.requestId, SESSION.accounts.approver.id);
    writeFileSync(STATE, JSON.stringify({ createdAt: new Date().toISOString(), set }, null, 2));
    const cap0 = mockState().calls.capture;

    // P: the full loop.
    await approveAndOrder(T, set.P);
    check("P: MOCK banner; environment MOCK; this payment USD 12.00 from the approval; fixed Sandbox test payee; local-demo note", (await T.evaluate(exists('[data-testid="mock-banner"]'))) && (await T.evaluate(`${text('[data-testid="pay-env"]')}.startsWith("MOCK")`)) && (await T.evaluate(text('[data-testid="pay-amount"]'))) === "USD 12.00" && (await T.evaluate(`${text('[data-testid="pay-payee"]')}.includes("Fixed Sandbox test merchant")`)) && (await T.evaluate(`${text('[data-testid="local-note"]')}.includes("the owning buyer pays")`)));
    check("P: double click on Start → exactly one payment record (TP-APPROVAL-MOCK, 1200 USD cents)", JSON.stringify(recordsOf(set.P.requestId)) === JSON.stringify([{ status: "ORDER_CREATED", sku: "TP-APPROVAL-MOCK", amount_minor: 1200, currency: "USD" }]), JSON.stringify(recordsOf(set.P.requestId)));
    await T.shot("30-pay-P-approved-buyer");
    await T.click(sel('[data-testid="pay-capture"]'), 2);
    await waitStatus(T, "PAID");
    check("P: double click on Capture → PAID; one capture request, one capture on the MOCK PayPal side", (await status(T)) === "PAID" && mockState().calls.capture === cap0 + 1 && recordsOf(set.P.requestId).length === 1, `captures sent ${mockState().calls.capture - cap0}`);
    await T.goto(set.P.approvalUrl, "Approvals of this request");
    check("P: reload → still PAID; no Start / order / capture button offered", (await status(T)) === "PAID" && !(await T.evaluate(exists('[data-testid="pay-start"], [data-testid="pay-order"], [data-testid="pay-capture"]'))));
    await T.shot("30-pay-P-paid");

    // I: basis changes after the order, before the capture.
    await approveAndOrder(T, set.I);
    const { ProcurementStore } = await import(pathToFileURL(join(process.cwd(), "src/server/procurement/store.ts")).href);
    const { validateProcurementInput } = await import(pathToFileURL(join(process.cwd(), "src/server/procurement/validate.ts")).href);
    const { recordToInput } = await import(pathToFileURL(join(process.cwd(), "src/lib/procurement.ts")).href);
    const ps = new ProcurementStore(DB);
    const r = ps.get(set.I.requestId);
    const input = recordToInput(r);
    input.items[0].quantity = "21";
    ps.update(set.I.requestId, r.revision, validateProcurementInput(input, "update").value);
    ps.close();
    const capI = mockState().calls.capture;
    await T.goto(set.I.approvalUrl, "Approvals of this request");
    check("I: after the request edit the approval is No longer valid; no capture / PayPal step offered", (await T.evaluate(exists('[data-approval][data-state="INVALIDATED"]'))) && !(await T.evaluate(exists('[data-testid="pay-capture"], [data-testid="pay-mock-approve"]'))));
    const forced = await T.evaluate(`(async () => { const id = document.querySelector('[data-approval]').dataset.approval; const r = await fetch("/api/procurements/${set.I.requestId}/approvals/" + id + "/payment/capture", { method: "POST", headers: { "Content-Type": "application/json", "X-TradeProof-CSRF": (document.cookie.match(/tp_csrf=([^;]+)/) || [])[1] || "" }, body: "{}" }); return r.status + " " + (await r.json()).code; })()`);
    check("I: a capture POST anyway → 409 APPROVAL_INVALID; record stays ORDER_CREATED; no capture request", forced === "409 APPROVAL_INVALID" && recordsOf(set.I.requestId)[0]?.status === "ORDER_CREATED" && mockState().calls.capture === capI, forced);
    await T.shot("30-pay-I-invalid");

    // U: capture outcome unknown.
    await approveAndOrder(T, set.U);
    const s = mockState();
    s.captureFaults = ["timeout-before-processing"];
    writeFileSync(MOCKFILE, JSON.stringify(s, null, 1));
    const capU = mockState().calls.capture;
    const capturedBefore = captures();
    await T.click(sel('[data-testid="pay-capture"]'));
    await waitStatus(T, "CAPTURE_UNKNOWN");
    check("U: queued MOCK timeout → CAPTURE_UNKNOWN shown with 'never sent again'; no Capture button", (await T.evaluate(`${text('[data-testid="payment-status"]')}.includes("never sent again")`)) && !(await T.evaluate(exists('[data-testid="pay-capture"]'))));
    await T.click(sel('[data-testid="pay-reconcile"]'));
    await T.waitFor(`${text('[data-testid="pay-message"]')}.includes("CAPTURE_UNKNOWN")`);
    check("U: Check with PayPal (read-only) → still CAPTURE_UNKNOWN; exactly one capture request in total", (await status(T)) === "CAPTURE_UNKNOWN" && mockState().calls.capture === capU + 1 && captures() === capturedBefore, `capture requests for U: ${mockState().calls.capture - capU}; new captures on the MOCK side: ${captures() - capturedBefore}`);
    await T.shot("30-pay-U-unknown");

    const writes = T.requests.filter((x) => /^(POST|PUT|PATCH|DELETE) /.test(x)).map((x) => x.replace(/^[A-Z]+ /, "").replace(BASE, "").replace(/[0-9a-f-]{36}/g, ":id").replace(/\?.*$/, ""));
    const allowed = [/^\/api\/procurements\/pr_:id\/approvals$/, /^\/api\/procurements\/pr_:id\/approvals\/ap_:id\/payment(\/(order|capture|reconcile|mock-approve))?$/, /^\/procurements\/pr_:id\/quotes\/approval$/];
    const unexpected = writes.filter((u) => !allowed.some((re) => re.test(u)));
    check("writes went only to approve and the approval payment endpoints", unexpected.length === 0, unexpected.join(" | ").slice(0, 300) || "(ok)");
  } else {
    const { set } = JSON.parse(readFileSync(STATE, "utf8"));
    SESSION = await e2eSession(DB, BASE, null);
    await signInBrowser(PORT, BASE, SESSION);
    const cap0 = mockState().calls.capture;
    await T.goto(set.P.approvalUrl, "Approvals of this request");
    check("after restart: P still PAID, one record, no pay buttons", (await status(T)) === "PAID" && recordsOf(set.P.requestId).length === 1 && !(await T.evaluate(exists('[data-testid="pay-start"], [data-testid="pay-capture"]'))));
    await T.goto(set.I.approvalUrl, "Approvals of this request");
    check("after restart: I still No longer valid, record ORDER_CREATED, no capture offered", (await T.evaluate(exists('[data-approval][data-state="INVALIDATED"]'))) && recordsOf(set.I.requestId)[0]?.status === "ORDER_CREATED" && !(await T.evaluate(exists('[data-testid="pay-capture"]'))));
    await T.goto(set.U.approvalUrl, "Approvals of this request");
    await hydrated(T, '[data-testid="pay-reconcile"]');
    await T.click(sel('[data-testid="pay-reconcile"]'), 2);
    await T.waitFor(`${text('[data-testid="pay-message"]')}.includes("CAPTURE_UNKNOWN")`);
    check("after restart: U Check (double click) → still CAPTURE_UNKNOWN; no capture request sent", (await status(T)) === "CAPTURE_UNKNOWN" && mockState().calls.capture === cap0);
  }
  check("no request to any other host (no PayPal SDK, no PayPal API from the browser)", external(T.requests).length === 0, external(T.requests).join(" | ").slice(0, 300) || "(none)");
  check("no console errors", T.errors.length === 0, T.errors.join(" | ").slice(0, 1500));
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
