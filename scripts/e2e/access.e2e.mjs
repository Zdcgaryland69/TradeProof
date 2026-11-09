// Browser check of sign-in and object-level access (30 Oct; manual run, not part of `npm test`). Works ONLY on a
// database COPY (E2E_DB, never data/sandbox-payments.sqlite). 3 Nov: the script creates its OWN per-run accounts there
// (e2e-buyer-a-<hex>, e2e-buyer-b-<hex>, e2e-approver-<hex>; display names "Buyer A <hex>" …) with random passwords held
// only in this process (never printed or written), so a consistent copy of the main database (which already has the
// demo accounts) can be used; existing accounts are never used or changed. It seeds one
// [TEST] SYNTHETIC record per buyer (scripts/seed-access-demo.mjs with SEED_DB), and drives FOUR separate Edge
// processes with separate profiles — Buyer A, Buyer B, Approver, signed out — so no cookie is shared.
// The dev server must run on the same copy: TRADEPROOF_DB_PATH=<copy> npm run dev (payment switch off).
//
//   E2E_DB=<copy> node scripts/e2e/access.e2e.mjs            HEADLESS=1 for headless Edge
//
// No model, token-count or PayPal request (switch off; MOCK extraction replay in the seed).

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MAIN = resolve(process.cwd(), "data", "sandbox-payments.sqlite");
const DB = process.env.E2E_DB ? resolve(process.env.E2E_DB) : null;
if (!DB || DB.toLowerCase() === MAIN.toLowerCase() || !existsSync(DB)) {
  console.error("E2E_DB must name an existing database COPY (never data/sandbox-payments.sqlite).");
  process.exit(2);
}
const SHOTS = join(process.cwd(), "data", "e2e-screens");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- accounts (copy only) + seed ----------
const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);
const [{ AuthStore }, { AuthService }] = await Promise.all([load("src/server/auth/store.ts"), load("src/server/auth/service.ts")]);
const TAG = randomBytes(3).toString("hex");
const U = { a: `e2e-buyer-a-${TAG}`, b: `e2e-buyer-b-${TAG}`, approver: `e2e-approver-${TAG}` };
const NAME = { a: `Buyer A ${TAG}`, b: `Buyer B ${TAG}`, approver: `Approver ${TAG}` };
const pw = { [U.a]: randomBytes(15).toString("base64url"), [U.b]: randomBytes(15).toString("base64url"), [U.approver]: randomBytes(15).toString("base64url") };
{
  const store = new AuthStore(DB);
  const auth = new AuthService(store);
  await auth.createAccount(U.a, "BUYER", NAME.a, pw[U.a]);
  await auth.createAccount(U.b, "BUYER", NAME.b, pw[U.b]);
  await auth.createAccount(U.approver, "APPROVER", NAME.approver, pw[U.approver]);
  store.close();
}
const seed = JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/seed-access-demo.mjs"], { env: { ...process.env, SEED_DB: DB, SEED_BUYER_A: U.a, SEED_BUYER_B: U.b }, encoding: "utf8" }));
const A = seed.records.A;
const B = seed.records.B;
check("seeded one [TEST] SYNTHETIC record per buyer in the copy", !!A?.requestId && !!B?.requestId);

// ---------- browsers ----------
const edges = [];
const profiles = [];
async function browser(name) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), `tradeproof-e2e-access-${name}-`));
  profiles.push(profile);
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,900", "about:blank"];
  if (process.env.HEADLESS === "1") args.unshift("--headless=new");
  edges.push(spawn(EDGE, args, { stdio: "ignore" }));
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
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
    async type(selector, value) {
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    },
    async shot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, `${file}.png`), Buffer.from(data, "base64"));
    },
  });
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  return tab;
}

const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const text = () => `document.body.innerText`;
const hydrated = (t, css) => t.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(css)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`);
async function signIn(t, username) {
  await t.goto(`${BASE}/login`);
  await hydrated(t, '[data-testid="login-submit"]');
  await t.type('[data-field="username"]', username);
  await t.type('[data-field="password"]', pw[username]);
  await t.click(sel('[data-testid="login-submit"]'));
  await t.waitFor(`location.pathname === "/procurements" && !!${sel('[data-testid="signed-in-name"]')}`);
}
// The Access panel lists every approver account in the database; pick this run's approver row by display name (a copy
// of the main database also holds the demo approver).
const myRow = `[...document.querySelectorAll('[data-testid="approver-row"]')].find((r) => r.innerText.includes(${JSON.stringify(NAME.approver)}))`;
const listIds = (t) => t.evaluate(`[...document.querySelectorAll('a[href^="/procurements/pr_"]')].map((a) => a.getAttribute("href").split("/")[2]).filter((v, i, s) => s.indexOf(v) === i)`);
const is404 = (t) => t.evaluate(`document.title.includes("404") || document.body.innerText.includes("could not be found") || document.body.innerText.includes("Not found")`);

let ta, tb, tp, tx;
try {
  [ta, tb, tp, tx] = await Promise.all([browser("buyerA"), browser("buyerB"), browser("approver"), browser("signedOut")]);

  // Signed out.
  await tx.goto(A.requestUrl);
  check("signed out: A's record URL → sign-in page", (await tx.evaluate("location.pathname")) === "/login");
  const api = await tx.evaluate(`fetch("/api/procurements").then((r) => r.status)`);
  check("signed out: API → 401", api === 401, String(api));

  // Sign-ins (separate browsers).
  await signIn(ta, U.a);
  await signIn(tb, U.b);
  await signIn(tp, U.approver);
  check("three separate browsers signed in as Buyer A / Buyer B / Approver", (await ta.evaluate(`${sel('[data-testid="signed-in-name"]')}.innerText`)) === NAME.a && (await tb.evaluate(`${sel('[data-testid="signed-in-name"]')}.innerText`)) === NAME.b && (await tp.evaluate(`${sel('[data-testid="signed-in-name"]')}.innerText`)) === NAME.approver);
  const la = await listIds(ta);
  const lb = await listIds(tb);
  const lp = await listIds(tp);
  check("lists: A sees only A's record, B only B's, approver nothing yet", JSON.stringify(la) === JSON.stringify([A.requestId]) && JSON.stringify(lb) === JSON.stringify([B.requestId]) && lp.length === 0, `A ${la.length}, B ${lb.length}, approver ${lp.length}`);
  await ta.shot("31-access-A-list");

  await tb.goto(A.requestUrl);
  check("B opens A's record URL → 404", await is404(tb));
  const bApi = await tb.evaluate(`fetch("/api/procurements/${A.requestId}").then((r) => r.status)`);
  check("B calls A's record API → 404", bApi === 404, String(bApi));
  await tb.goto(`${BASE}/procurements?q=${encodeURIComponent("Buyer A")}`);
  check("B searches for A's title → no result", !(await tb.evaluate(`document.body.innerText.includes(${JSON.stringify(A.requestId.slice(3, 11).toUpperCase())})`)));
  await tp.goto(A.approvalUrl);
  check("approver, not assigned: A's approval page → 404", await is404(tp));

  // A assigns the approver.
  await ta.goto(A.requestUrl);
  await hydrated(ta, '[data-testid="approver-grant"]');
  await ta.click(`${myRow}?.querySelector('[data-testid="approver-grant"]')`);
  await ta.waitFor(`${myRow}?.dataset.assigned === "yes"`);
  check("A assigns the approver (owner-only control)", true);
  await ta.goto(A.approvalUrl);
  check("A (buyer) on the approval page: no Approve button, told only the assigned approver can approve", !(await ta.evaluate(`!!${sel('[data-testid="approve"]')}`)) && (await ta.evaluate(`${text()}.includes("A buyer cannot approve its own request")`)));

  // Approver approves; no edit, no payment.
  await tp.goto(A.requestUrl);
  check("approver, assigned: sees A's record read-only (no Edit, approver note)", !(await tp.evaluate(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Edit")`)) && (await tp.evaluate(`!!${sel('[data-testid="approver-readonly"]')}`)));
  await tp.goto(A.approvalUrl);
  await hydrated(tp, '[data-testid="approve"]');
  await tp.click(sel('[data-testid="approve"]'));
  await tp.waitFor(`!!document.querySelector('[data-approval][data-state="ACTIVE"]')`);
  check("approver approves → one Active approval recorded as Approver (signed in)", await tp.evaluate(`${text()}.includes(${JSON.stringify(`${NAME.approver} (approver, signed in)`)})`));
  check("approver: no payment controls ('Payment is the owning buyer's step')", (await tp.evaluate(`!!${sel('[data-testid="pay-buyer-only"]')}`)) && !(await tp.evaluate(`!!${sel('[data-testid="pay-start"]')}`)));
  await tp.shot("31-access-approver-approved");
  const apEdit = await tp.evaluate(`fetch("/api/procurements/${A.requestId}", { method: "PUT", headers: { "Content-Type": "application/json", "X-TradeProof-CSRF": (document.cookie.match(/tp_csrf=([^;]+)/) || [])[1] || "" }, body: "{}" }).then((r) => r.status)`);
  check("approver tries to edit A's request through the API → 404", apEdit === 404, String(apEdit));

  // A removes the approver → immediate effect; the approval can no longer be used.
  await ta.goto(A.requestUrl);
  await hydrated(ta, '[data-testid="approver-revoke"]');
  await ta.click(`${myRow}?.querySelector('[data-testid="approver-revoke"]')`);
  await ta.waitFor(`${myRow}?.dataset.assigned === "no"`);
  await tp.goto(A.approvalUrl);
  check("removed approver: next request → 404", await is404(tp));
  await ta.goto(A.approvalUrl);
  check("A sees the approval No longer valid (approver removed)", (await ta.evaluate(`!!document.querySelector('[data-approval][data-state="INVALIDATED"]')`)) && (await ta.evaluate(`${text()}.includes("removed the approver")`)));
  await ta.shot("31-access-A-approver-removed");

  // Sign-out: the old cookie stops working.
  const cookies = (await ta.send("Network.getCookies", { urls: [BASE] })).cookies.filter((c) => c.name === "tp_session" || c.name === "tp_csrf");
  check("session cookie HttpOnly + SameSite=Strict (local http: not Secure)", cookies.some((c) => c.name === "tp_session" && c.httpOnly && c.sameSite === "Strict" && !c.secure));
  await ta.click(sel('[data-testid="sign-out"]'));
  await ta.waitFor(`location.pathname === "/login"`);
  for (const c of cookies) await ta.send("Network.setCookie", { name: c.name, value: c.value, url: BASE, httpOnly: c.httpOnly, sameSite: c.sameSite });
  await ta.goto(A.requestUrl);
  check("after sign-out, the old session cookie put back → still the sign-in page", (await ta.evaluate("location.pathname")) === "/login");

  const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
  const ext = [ta, tb, tp, tx].flatMap((t) => t.requests).map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !u.startsWith("about:") && !LOCAL.some((l) => u.startsWith(l)));
  check("no request to any other host", ext.length === 0, ext.slice(0, 3).join(" | ") || "(none)");
  const errs = [ta, tb, tp, tx].flatMap((t) => t.errors.map((e) => `${t.name}: ${e}`)).filter((e) => !/status of 40[134]/.test(e));
  check("no console errors (expected 401 / 403 / 404 responses excluded)", errs.length === 0, errs.join(" | ").slice(0, 600));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  for (const t of [ta, tb, tp, tx]) t?.close();
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
