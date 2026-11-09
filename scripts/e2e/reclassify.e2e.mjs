// Browser check of requirement reclassification on the approval page (7 Nov; manual run, not part of `npm test`).
// Database COPY only, server `mock:start` on the same copy. Uses the record and throwaway sessions that
// `chain.e2e.mjs --ui-prep` left next to the copy (<copy>.e2e-ui-sessions.json). Every action is a real click / key
// press in Edge; rows are read from the copy (read-only) after each step. No model, token-count or PayPal request.
//
//   E2E_DB=<copy> HEADLESS=1 node scripts/e2e/reclassify.e2e.mjs
//
// 1 buyer: current classification + history shown; Reclassify opens a form with NO option selected, Save disabled;
//   Cancel closes it and sends nothing.
// 2 approver approves through the page (ticks the confirmation; the box starts unticked).
// 3 buyer: the form warns that the Active approval will stop being valid; an identical re-save → "Nothing changed",
//   no row, approval still Active.
// 4 a second tab holding the old form → after tab 1 saves a correction, tab 2's save is refused (stale), no row.
// 5 after the correction: new row, old rows kept, the approval is No longer valid (CLASSIFICATIONS_CHANGED) on the page.
// 6 keyboard: Reclassify reachable with Tab, opens with Enter, visible focus outline.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { e2eDb, signInBrowser } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const SHOTS = join(process.cwd(), "data", "ux-review-2026-11-07", "reclassify");
mkdirSync(SHOTS, { recursive: true });
const st = JSON.parse(readFileSync(`${DB}.e2e-ui-sessions.json`, "utf8"));
const { request: R, series: S, v2: V2, run2 } = st.ids;
const URL_ = `${BASE}/procurements/${R}/quotes/approval?series=${S}&version=${V2}&run=${run2}`;
const PORT = 9500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const q = (sql, ...p) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return c.prepare(sql).all(...p);
  } finally {
    c.close();
  }
};
const rows = () => q("SELECT id, decision, reason FROM requirement_classifications WHERE version_id = ? AND subject = 'ADDITIONAL_REQUIREMENTS' ORDER BY created_at, rowid", V2);
const CARD = `document.querySelector('[data-classify="ADDITIONAL_REQUIREMENTS"]')`;

async function openTab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const w = new Map();
  const t = { posts: [], errors: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) {
      w.get(m.id)(m.result ?? { error: m.error });
      w.delete(m.id);
      return;
    }
    if (m.method === "Network.requestWillBeSent" && m.params.request.method !== "GET" && !m.params.request.url.includes("/_next/")) t.posts.push(`${m.params.request.method} ${m.params.request.url}`);
    if (m.method === "Runtime.exceptionThrown") t.errors.push(m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") t.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200));
  };
  t.send = (method, params = {}) => new Promise((r) => { w.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })); });
  t.eval = async (expression) => (await t.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value;
  t.waitFor = async (expr, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await t.eval(expr).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`timeout: ${expr.slice(0, 150)}`);
  };
  t.goto = async (url) => {
    await t.send("Page.bringToFront");
    await t.send("Page.navigate", { url });
    await t.waitFor(`document.readyState === "complete"`, 60000).catch(() => {});
    try {
      await t.waitFor(`document.readyState === "complete" && !!document.querySelector('[data-testid="approval-status"]') && !!${CARD} && Object.keys(${CARD}.querySelector("button") ?? {}).some((k) => k.startsWith("__reactFiber")) || (document.readyState === "complete" && !!document.querySelector('[data-testid="approve"]') && Object.keys(document.querySelector('[data-testid="approve"]')).some((k) => k.startsWith("__reactFiber")))`, 60000);
    } catch (e) {
      await t.shot(`timeout-${Date.now()}`).catch(() => {});
      throw new Error(`${e.message.slice(0, 80)} — page: ${(await t.eval("document.body.innerText").catch(() => "")).slice(0, 200).replace(/s+/g, " ")}`);
    }
  };
  t.click = async (expr) => {
    await t.send("Page.bringToFront");
    const box = await t.eval(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: e === hit || e.contains(hit) }; })()`);
    if (!box?.ok) throw new Error(`not clickable: ${expr.slice(0, 120)}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  t.type = async (expr, text) => {
    await t.click(expr);
    await t.eval(`(() => { const e = ${expr}; e.select?.(); return true; })()`);
    await t.send("Input.insertText", { text });
  };
  t.key = async (key, code = key) => {
    await t.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: key === "Tab" ? 9 : key === "Enter" ? 13 : 0, ...(key === "Enter" ? { text: String.fromCharCode(13) } : {}) });
    await t.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: key === "Tab" ? 9 : key === "Enter" ? 13 : 0 });
  };
  t.shot = async (name) => {
    const { data } = await t.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  };
  for (const d of ["Page", "Runtime", "Network"]) await t.send(`${d}.enable`);
  await t.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  return t;
}
const inCard = (css) => `${CARD}.querySelector(${JSON.stringify(css)})`;

const profile = mkdtempSync(join(tmpdir(), "tp-reclassify-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  const before = rows();
  check("start: two classification rows (the mis-selection and its correction)", before.length === 2, JSON.stringify(before.map((r) => r.decision)));

  // 1. buyer: current + history; Reclassify → no default; Cancel sends nothing.
  await signInBrowser(PORT, BASE, st.buyer);
  const A = await openTab();
  await A.goto(URL_);
  check("buyer: card shows the current decision and 'Earlier classifications (1)'", (await A.eval(`${inCard('[data-testid="classification-current"]')}.innerText`)).includes("Key condition — the quote states it") && (await A.eval(`${inCard('[data-testid="classification-history"] summary')}.innerText`)) === "Earlier classifications (1)");
  let mark = A.posts.length;
  await A.click(inCard('[data-testid="reclassify"]'));
  await A.waitFor(`!!${inCard('[data-testid="classify-form"]')}`);
  check("Reclassify opens the form with no option selected; Save disabled", (await A.eval(`[...${CARD}.querySelectorAll('input[type=radio]')].every((r) => !r.checked)`)) && (await A.eval(`${inCard('[data-testid="classify-save"]')}.disabled`)));
  check("no Active approval yet → no invalidation warning", !(await A.eval(`!!${inCard('[data-testid="classify-warn-active"]')}`)));
  await A.shot("01-buyer-form-open");
  await A.click(inCard('[data-testid="classify-cancel"]'));
  await A.waitFor(`!${inCard('[data-testid="classify-form"]')}`);
  check("Cancel closes the form, sends no request, stores nothing", A.posts.length === mark && rows().length === 2, A.posts.slice(mark).join(" | "));

  // 2. approver approves through the page.
  await signInBrowser(PORT, BASE, st.approver);
  const AP = await openTab();
  await AP.goto(URL_);
  check("approver: confirmation box starts unticked; Approve disabled", (await AP.eval(`[...document.querySelectorAll('[data-testid="confirm-list"] input')].every((b) => !b.checked)`)) && (await AP.eval(`document.querySelector('[data-testid="approve"]').disabled`)));
  await AP.click(`document.querySelector('[data-testid="confirm-list"] label')`);
  await AP.waitFor(`!document.querySelector('[data-testid="approve"]').disabled`);
  await AP.shot("02-approver-ticked");
  await AP.click(`document.querySelector('[data-testid="approve"]')`);
  await AP.waitFor(`!!document.querySelector('[data-testid="approve-result"][data-state="ACTIVE"], [data-testid="approved-active"]')`);
  const ap = q("SELECT id FROM approvals WHERE request_id = ? ORDER BY created_at DESC LIMIT 1", R)[0];
  check("approval stored (one row) and read back Active on the page", !!ap && q("SELECT count(*) n FROM approvals WHERE request_id = ?", R)[0].n === 1);
  AP.send("Page.close").catch(() => {});

  // 3. buyer: warning, identical re-save → UNCHANGED.
  await signInBrowser(PORT, BASE, st.buyer);
  await A.goto(URL_);
  check("buyer: sheet shows Approval ✓ Approved — Active", (await A.eval(`document.querySelector('[data-testid="sheet-approval"]').dataset.state`)) === "ACTIVE");
  await A.click(inCard('[data-testid="reclassify"]'));
  await A.waitFor(`!!${inCard('[data-testid="classify-form"]')}`);
  check("form warns that saving makes the Active approval no longer valid", (await A.eval(`${inCard('[data-testid="classify-warn-active"]')}?.innerText ?? ""`)).includes("no longer valid"));
  const cur = rows().at(-1);
  await A.click(inCard('input[value="KEY_IN_QUOTE"]'));
  await A.type(inCard('[data-field="reason"]'), cur.reason);
  await A.type(inCard('[data-field="excerpt"]'), "20 个（样品单）");
  await A.shot("03-buyer-identical");
  mark = A.posts.length;
  await A.click(inCard('[data-testid="classify-save"]'));
  await A.waitFor(`(${inCard('[data-testid="classify-message"]')}?.innerText ?? "").length > 0`);
  check("identical re-save → 'Nothing changed', no row, approval still Active", (await A.eval(`${inCard('[data-testid="classify-message"]')}.innerText`)).startsWith("Nothing changed") && rows().length === 2 && q("SELECT count(*) n FROM approval_events WHERE approval_id = ?", ap.id)[0].n === 0, `POSTs ${A.posts.length - mark}`);

  // 4. second tab with the old form open; tab 1 saves a correction; tab 2's save is refused.
  const B2 = await openTab();
  await B2.goto(URL_);
  await B2.click(inCard('[data-testid="reclassify"]'));
  await B2.waitFor(`!!${inCard('[data-testid="classify-form"]')}`);
  await B2.click(inCard('input[value="NOT_KEY"]'));
  await B2.type(inCard('[data-field="reason"]'), "stale tab — must not win");
  // tab 1: real correction (new reason).
  await A.type(inCard('[data-field="reason"]'), "Sample order of 20 pcs; the revised quote states 样品单 (reworded 7 Nov UI check).");
  await A.click(inCard('[data-testid="classify-save"]'));
  await A.waitFor(`(${inCard('[data-testid="classify-message"]')}?.innerText ?? "").startsWith("Classification saved")`);
  const afterFix = rows();
  check("correction saved: a third row; the two earlier rows kept unchanged", afterFix.length === 3 && afterFix[0].id === before[0].id && afterFix[1].id === before[1].id && afterFix[2].decision === "KEY_IN_QUOTE");
  await B2.click(inCard('[data-testid="classify-save"]'));
  await B2.waitFor(`(${inCard('[data-testid="classify-message"]')}?.innerText ?? "").length > 0`);
  check("stale second tab → refused ('classified again since you opened the form'), no row", (await B2.eval(`${inCard('[data-testid="classify-message"]')}.innerText`)).includes("classified again") && rows().length === 3);
  await B2.shot("04-stale-tab-refused");

  // 5. page after the correction.
  await A.goto(URL_);
  const histState = await A.eval(`document.querySelector('[data-approval="${ap.id}"]')?.dataset.state`);
  const reasons = await A.eval(`document.querySelector('[data-approval="${ap.id}"] [data-testid="validity-reasons"]')?.innerText ?? ""`);
  check("approval now No longer valid on the page (a free-text requirement was classified again); sheet not Active", histState === "INVALIDATED" && reasons.includes("classified again") && (await A.eval(`document.querySelector('[data-testid="sheet-approval"]').dataset.state`)) !== "ACTIVE", `${histState} · ${reasons}`);
  check("card: 'Earlier classifications (2)'; current = the reworded correction", (await A.eval(`${inCard('[data-testid="classification-history"] summary')}.innerText`)) === "Earlier classifications (2)" && (await A.eval(`${CARD}.innerText`)).includes("reworded 7 Nov UI check"));
  await A.shot("05-after-correction");

  // 6. keyboard.
  await A.eval(`${inCard('[data-testid="classification-history"] summary')}.focus()`);
  await A.key("Tab");
  const focusInfo = await A.eval(`(() => { const e = document.activeElement; return { testid: e?.dataset?.testid ?? e?.tagName, outline: getComputedStyle(e).outlineStyle, visible: e.matches(":focus-visible") }; })()`);
  const focused = focusInfo.testid === "reclassify" && focusInfo.outline !== "none" && focusInfo.visible;
  await A.key("Enter");
  await A.waitFor(`!!${inCard('[data-testid="classify-form"]')}`, 5000).catch(() => {});
  check("keyboard: Tab reaches Reclassify with a visible outline; Enter opens the form", focused && (await A.eval(`!!${inCard('[data-testid="classify-form"]')}`)), JSON.stringify(focusInfo));
  check("no console errors on the pages", A.errors.length === 0 && B2.errors.length === 0, [...A.errors, ...B2.errors].slice(0, 3).join(" | "));
} catch (e) {
  check("run", false, e.message);
} finally {
  edge.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} / ${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
