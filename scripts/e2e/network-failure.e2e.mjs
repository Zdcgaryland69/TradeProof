// Targeted network-failure check (7–8 Nov; manual run, not part of `npm test`). Database COPY only, `mock:start` on the
// same copy, record + throwaway sessions from `chain.e2e.mjs --ui-prep`. Edge's DevTools Fetch interception cuts ONE
// write:  NOT SENT — failed at the request stage (the server never receives it);
//         LOST     — failed at the response stage (the server has processed it; the browser sees a network error).
// The page cannot know which one happened (the product does not use anything only the test tool knows). For each form:
//   - rows: NOT SENT → none written; LOST → exactly one;
//   - the page shows the neutral "couldn't confirm" message — never "saved", "Not approved" or "Not saved";
//   - no automatic re-send; the Check status action sends NO write (POST count unchanged) and leaves the rows unchanged,
//     and then states what is stored;
//   - an explicit server refusal (422 / 409) still shows its specific reason.
// History: the 7 Nov version (9/9) only checked rows / no re-send / safe repeat; it did not check the wording.
// No model, token-count or PayPal request (MOCK payments, MOCK extraction).
//
//   E2E_DB=<copy> HEADLESS=1 node scripts/e2e/network-failure.e2e.mjs

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, signInBrowser } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const st = JSON.parse(readFileSync(`${DB}.e2e-ui-sessions.json`, "utf8"));
const { request: R, series: S, v1: V1, v2: V2, run2 } = st.ids;
const APPROVAL = `${BASE}/procurements/${R}/quotes/approval?series=${S}&version=${V2}&run=${run2}`;
const QUOTES_V1 = `${BASE}/procurements/${R}/quotes?series=${S}&version=${V1}`;
const UNKNOWN = "We couldn't confirm the result. Your change may have been saved. Check the current status before trying again.";
const DEFINITE = /Not approved|Not saved|Save failed|Classification saved|Could not reach/;
const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const n = (sql, ...p) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return Number(Object.values(c.prepare(sql).get(...p))[0]);
  } finally {
    c.close();
  }
};

async function openTab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const w = new Map();
  const t = { writes: [], cut: null };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) {
      w.get(m.id)(m.result ?? { error: m.error });
      w.delete(m.id);
      return;
    }
    if (m.method === "Network.requestWillBeSent" && ["POST", "PUT", "DELETE", "PATCH"].includes(m.params.request.method) && !m.params.request.url.includes("/_next/")) t.writes.push(m.params.request.url.replace(BASE, ""));
    if (m.method === "Fetch.requestPaused") {
      const p = m.params;
      if (t.cut && p.request.method === "POST" && t.cut.test(p.request.url)) {
        t.cut = null; // only the first matching write
        t.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" });
      } else t.send("Fetch.continueRequest", { requestId: p.requestId });
    }
  };
  t.send = (method, params = {}) => new Promise((r) => { w.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })); });
  t.eval = async (expression) => (await t.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value;
  t.waitFor = async (expr, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await t.eval(expr).catch(() => false)) return true;
      await sleep(150);
    }
    throw new Error(`timeout: ${expr.slice(0, 140)}`);
  };
  t.click = async (expr) => {
    await t.send("Page.bringToFront");
    const box = await t.eval(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: e === hit || e.contains(hit) }; })()`);
    if (!box?.ok) throw new Error(`not clickable: ${expr.slice(0, 120)}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  t.type = async (expr, text) => {
    await t.click(expr);
    await t.send("Input.insertText", { text });
  };
  t.go = async (url, ready) => {
    await t.send("Page.bringToFront");
    await t.send("Page.navigate", { url });
    await t.waitFor(`document.readyState === "complete" && ${ready}`, 60000);
  };
  t.cutNext = async (match, stage) => {
    t.cut = match;
    await t.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: stage === "LOST" ? "Response" : "Request" }] });
  };
  t.stopCut = async () => {
    t.cut = null;
    await t.send("Fetch.disable");
  };
  for (const d of ["Page", "Runtime", "Network"]) await t.send(`${d}.enable`);
  await t.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  return t;
}
const hydrated = (css) => `!!document.querySelector('${css}') && Object.keys(document.querySelector('${css}')).some((k) => k.startsWith("__reactFiber"))`;
const text = (expr) => `(${expr}?.innerText ?? "")`;
const CARD = `document.querySelector('[data-classify="ADDITIONAL_REQUIREMENTS"]')`;

const profile = mkdtempSync(join(tmpdir(), "tp-netfail-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }

  // ---------- 1. Classification (buyer) ----------
  const cls = () => n("SELECT count(*) FROM requirement_classifications WHERE version_id = ? AND subject = 'ADDITIONAL_REQUIREMENTS'", V2);
  await signInBrowser(PORT, BASE, st.buyer);
  const B = await openTab();
  const openClassify = async (excerpt, reason) => {
    await B.go(APPROVAL, hydrated('[data-classify="ADDITIONAL_REQUIREMENTS"] [data-testid="reclassify"]'));
    await B.click(`${CARD}.querySelector('[data-testid="reclassify"]')`);
    await B.waitFor(`!!${CARD}.querySelector('[data-testid="classify-form"]')`);
    await B.click(`${CARD}.querySelector('input[value="KEY_IN_QUOTE"]')`);
    await B.type(`${CARD}.querySelector('[data-field="reason"]')`, reason);
    await B.type(`${CARD}.querySelector('[data-field="excerpt"]')`, excerpt);
  };
  const unknownCard = async (label, expectRows, expectAfterCheck) => {
    await B.waitFor(`!!${CARD}.querySelector('[data-testid="classify-unknown"]')`, 15000);
    const msg = await B.eval(text(`${CARD}.querySelector('[data-testid="classify-unknown"]')`));
    check(`classification ${label}: neutral message, no "saved" / "not saved" claim; Save withheld`, msg.includes(UNKNOWN) && !DEFINITE.test(msg) && (await B.eval(`${CARD}.querySelector('[data-testid="classify-save"]').disabled`)), msg.slice(0, 90));
    check(`classification ${label}: ${expectRows.label}`, cls() === expectRows.rows, `rows ${cls()}`);
    const w0 = B.writes.length;
    await B.click(`${CARD}.querySelector('[data-testid="classify-check-status"]')`);
    await B.waitFor(`["stored","notStored"].includes(${CARD}.querySelector('[data-testid="classify-unknown"]')?.dataset.check)`, 15000);
    const state = await B.eval(`${CARD}.querySelector('[data-testid="classify-unknown"]').dataset.check`);
    check(`classification ${label}: Check status sends no write, rows unchanged, says "${expectAfterCheck}"`, B.writes.length === w0 && cls() === expectRows.rows && state === expectAfterCheck, `${state}`);
  };
  const c0 = cls();
  await openClassify("20 个（样品单）", "Network check (not sent): the request is a 20-piece sample order; the quote states 20 个（样品单）.");
  await B.cutNext(/requirement-classifications$/, "NOT_SENT");
  let w0 = B.writes.length;
  await B.click(`${CARD}.querySelector('[data-testid="classify-save"]')`);
  await unknownCard("NOT SENT", { rows: c0, label: "nothing written; one POST" }, "notStored");
  check("classification NOT SENT: exactly one POST was attempted (no automatic re-send)", B.writes.length - w0 === 1);
  check("classification NOT SENT: after the check, Save is offered again", !(await B.eval(`${CARD}.querySelector('[data-testid="classify-save"]').disabled`)));
  await B.stopCut();
  await openClassify("20 个（样品单）", "Network check (lost): the request is a 20-piece sample order; the quote states 20 个（样品单）.");
  await B.cutNext(/requirement-classifications$/, "LOST");
  w0 = B.writes.length;
  await B.click(`${CARD}.querySelector('[data-testid="classify-save"]')`);
  await unknownCard("LOST", { rows: c0 + 1, label: "exactly one row written" }, "stored");
  check("classification LOST: one POST only (no automatic re-send); Save stays withheld after 'stored'", B.writes.length - w0 === 1 && (await B.eval(`${CARD}.querySelector('[data-testid="classify-save"]').disabled`)));
  await B.stopCut();
  // Explicit server refusal (422): the specific reason is shown, not the neutral message.
  await openClassify("50 个（样品单）", "Excerpt that is not in the quote.");
  const c1 = cls();
  await B.click(`${CARD}.querySelector('[data-testid="classify-save"]')`);
  await B.waitFor(`(${text(`${CARD}.querySelector('[data-testid="classify-message"]')`)}).length > 0`, 15000);
  const refusal = await B.eval(text(`${CARD}.querySelector('[data-testid="classify-message"]')`));
  check("classification 422 (excerpt not in the quote): specific server reason shown; no row; no neutral message", refusal.includes("does not occur") && cls() === c1 && !(await B.eval(`!!${CARD}.querySelector('[data-testid="classify-unknown"]')`)), refusal.slice(0, 90));

  // ---------- 2. Review confirm (buyer, new MOCK run of v1 → pending rows) ----------
  const res = await authedFetch(BASE, st.buyer, `/api/procurements/${R}/quotes/${S}/versions/${V1}/extractions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: randomUUID(), rerun: true }) });
  const run = (await res.json()).run;
  const revs = () => n("SELECT count(*) FROM quote_extraction_reviews WHERE extraction_id = ?", run.id);
  await B.go(QUOTES_V1, `${hydrated('[data-testid="review-next"]')} && !!document.querySelector("[data-pending-row][data-fact-path]")`);
  const pathA = await B.eval(`[...document.querySelectorAll("[data-pending-row][data-fact-path]")][0].dataset.factPath`);
  const pathB = await B.eval(`[...document.querySelectorAll("[data-pending-row][data-fact-path]")][1].dataset.factPath`);
  const row = (p) => `document.querySelector('[data-fact-path="${p}"]')`;
  const confirmBtn = (p) => `[...${row(p)}.querySelectorAll("button")].find((b) => b.innerText === "Confirm")`;
  const reviewCase = async (p, stage, expectRows, expectReviewed) => {
    await B.cutNext(/\/reviews$/, stage);
    const w = B.writes.length;
    await B.click(confirmBtn(p));
    await B.waitFor(`!!${row(p)}.querySelector('[data-testid="review-unknown"]')`, 15000);
    const msg = await B.eval(text(`${row(p)}.querySelector('[data-testid="review-unknown"]')`));
    check(`review ${stage}: neutral message; no "Not saved"; review buttons withheld`, msg.includes(UNKNOWN) && !DEFINITE.test(msg) && !(await B.eval(`!!${confirmBtn(p)}`)), msg.slice(0, 80));
    check(`review ${stage}: ${expectRows === 0 ? "nothing written" : "exactly one review written"}; one POST`, revs() === expectRows && B.writes.length - w === 1, `reviews ${revs()}`);
    await B.stopCut();
    const w2 = B.writes.length;
    await B.click(`${row(p)}.querySelector('[data-testid="review-check-status"]')`);
    await B.waitFor(`!${row(p)}.querySelector('[data-testid="review-unknown"]')`, 15000);
    const reviewed = await B.eval(`!!${row(p)}.querySelector('[data-review="CONFIRM"]')`);
    check(`review ${stage}: Check status sends no write; row then shows ${expectReviewed ? "the stored review" : "pending again with its buttons"}`, B.writes.length === w2 && revs() === expectRows && reviewed === expectReviewed && (expectReviewed || (await B.eval(`!!${confirmBtn(p)}`))));
  };
  await reviewCase(pathA, "NOT_SENT", 0, false);
  await reviewCase(pathB, "LOST", 1, true);

  // ---------- 3. Approve (approver) ----------
  const apps = () => n("SELECT count(*) FROM approvals WHERE request_id = ?", R);
  await signInBrowser(PORT, BASE, st.approver);
  const A = await openTab();
  const approveCase = async (stage, expectRows, expectAfter) => {
    await A.go(APPROVAL, hydrated('[data-testid="approve"]'));
    for (const i of await A.eval(`[...document.querySelectorAll('[data-testid="confirm-list"] input')].map((_, i) => i)`)) await A.click(`document.querySelectorAll('[data-testid="confirm-list"] label')[${i}]`);
    await A.cutNext(/\/approvals$/, stage);
    const w = A.writes.length;
    await A.click(`document.querySelector('[data-testid="approve"]')`);
    await A.waitFor(`!!document.querySelector('[data-testid="approve-unknown"]')`, 15000);
    const msg = await A.eval(text(`document.querySelector('[data-testid="approve-unknown"]')`));
    check(`approve ${stage}: neutral message, no "Not approved"; Approve button withheld`, msg.includes(UNKNOWN) && !DEFINITE.test(msg) && !(await A.eval(`!!document.querySelector('[data-testid="approve"]')`)), msg.slice(0, 80));
    check(`approve ${stage}: ${expectRows === 0 ? "no approval written" : "exactly one approval written"}; one POST`, apps() === expectRows && A.writes.length - w === 1, `approvals ${apps()}`);
    await A.stopCut();
    const w2 = A.writes.length;
    await A.click(`document.querySelector('[data-testid="approve-check-status"]')`);
    await A.waitFor(`!document.querySelector('[data-testid="approve-unknown"]')`, 15000);
    const shown = expectAfter === "ACTIVE" ? await A.eval(`document.querySelector('[data-testid="approve-result"]')?.dataset.state === "ACTIVE"`) : await A.eval(`!!document.querySelector('[data-testid="approve-not-stored"]') && !!document.querySelector('[data-testid="approve"]')`);
    check(`approve ${stage}: Check status (read-only GET) sends no write; shows ${expectAfter === "ACTIVE" ? "Approved — Active" : "'no approval stored' + the Approve button"}`, A.writes.length === w2 && apps() === expectRows && shown);
  };
  await approveCase("NOT_SENT", 0, "NONE");
  await approveCase("LOST", 1, "ACTIVE");

  // ---------- 4. Revoke (buyer) — LOST ----------
  // Both tabs share one browser profile (cookies): switch the profile to the buyer before using tab B again.
  await signInBrowser(PORT, BASE, st.buyer);
  const revoked = () => n("SELECT count(*) FROM approval_events e JOIN approvals a ON a.id = e.approval_id WHERE a.request_id = ? AND e.kind = 'REVOKED'", R);
  await B.go(APPROVAL, hydrated('[data-testid="revoke"]'));
  await B.type(`document.querySelector('[data-field="revoke-reason"]')`, "Network check (lost response).");
  await B.cutNext(/\/revoke$/, "LOST");
  let w = B.writes.length;
  await B.click(`document.querySelector('[data-testid="revoke"]')`);
  await B.waitFor(`!!document.querySelector('[data-testid="revoke-unknown"]')`, 15000);
  const rmsg = await B.eval(text(`document.querySelector('[data-testid="revoke-unknown"]')`));
  check("revoke LOST: neutral message; Revoke withheld; exactly one REVOKED event; one POST", rmsg.includes(UNKNOWN) && !DEFINITE.test(rmsg) && (await B.eval(`document.querySelector('[data-testid="revoke"]').disabled`)) && revoked() === 1 && B.writes.length - w === 1, rmsg.slice(0, 60));
  await B.stopCut();
  w = B.writes.length;
  await B.click(`document.querySelector('[data-testid="revoke-check-status"]')`);
  await B.waitFor(`!document.querySelector('[data-testid="revoke-unknown"]')`, 15000);
  check("revoke: Check status sends no write; the page then shows the approval as Revoked", B.writes.length === w && revoked() === 1 && (await B.waitFor(`[...document.querySelectorAll("[data-approval]")].some((li) => li.dataset.state === "REVOKED")`, 15000).catch(() => false)));

  // ---------- 5. Payment (approver approves again; buyer pays) ----------
  await signInBrowser(PORT, BASE, st.approver);
  await A.go(APPROVAL, hydrated('[data-testid="approve"]'));
  for (const i of await A.eval(`[...document.querySelectorAll('[data-testid="confirm-list"] input')].map((_, i) => i)`)) await A.click(`document.querySelectorAll('[data-testid="confirm-list"] label')[${i}]`);
  await A.click(`document.querySelector('[data-testid="approve"]')`);
  await A.waitFor(`!!document.querySelector('[data-testid="approve-result"][data-state="ACTIVE"], [data-testid="approved-active"]')`, 15000);
  await signInBrowser(PORT, BASE, st.buyer);
  const recs = () => n("SELECT count(*) FROM approval_payments l JOIN approvals a ON a.id = l.approval_id WHERE a.request_id = ?", R);
  await B.go(APPROVAL, hydrated('[data-testid="pay-start"]'));
  await B.cutNext(/\/payment$/, "LOST");
  w = B.writes.length;
  await B.click(`document.querySelector('[data-testid="pay-start"]')`);
  await B.waitFor(`!!document.querySelector('[data-testid="pay-message"]')`, 15000);
  const pmsg = await B.eval(text(`document.querySelector('[data-testid="pay-message"]')`));
  check("payment start LOST: one record; message says the outcome is unknown and not to pay again (no 'could not reach'); one POST", recs() === 1 && /outcome of this payment step is unknown/.test(pmsg) && !/Could not reach/.test(pmsg) && B.writes.length - w === 1, pmsg.slice(0, 90));
  await B.stopCut();
} catch (e) {
  check("run", false, e.message);
} finally {
  edge.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed} / ${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
