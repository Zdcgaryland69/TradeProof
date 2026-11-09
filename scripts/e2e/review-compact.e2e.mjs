// Browser check of the compact review list on the Quotes page (7 Nov; manual run, not part of `npm test`). Database COPY
// only, `mock:start` on the same copy, record + throwaway buyer session from `chain.e2e.mjs --ui-prep`. A NEW MOCK run of
// version 1 is started through the app's API (real session + CSRF) so that every value is pending again; all review
// actions below are real clicks / key presses. No model, token-count or PayPal request (MOCK extraction).
//
//   E2E_DB=<copy> HEADLESS=1 node scripts/e2e/review-compact.e2e.mjs

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, signInBrowser } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const SHOTS = join(process.cwd(), "data", "ux-review-2026-11-07", "review-compact");
mkdirSync(SHOTS, { recursive: true });
const st = JSON.parse(readFileSync(`${DB}.e2e-ui-sessions.json`, "utf8"));
const { request: R, series: S, v1: V1 } = st.ids;
const PORT = 9600 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const reviews = (runId) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return c.prepare("SELECT field_path, action FROM quote_extraction_reviews WHERE extraction_id = ? ORDER BY created_at, rowid").all(runId);
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
  const t = { errors: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) {
      w.get(m.id)(m.result ?? { error: m.error });
      w.delete(m.id);
      return;
    }
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
  t.click = async (expr) => {
    await t.send("Page.bringToFront");
    const box = await t.eval(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: e === hit || e.contains(hit) }; })()`);
    if (!box?.ok) throw new Error(`not clickable: ${expr.slice(0, 120)}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  t.enter = async () => {
    await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
    await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  t.shot = async (name) => {
    const { data } = await t.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  };
  for (const d of ["Page", "Runtime", "Network"]) await t.send(`${d}.enable`);
  await t.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  return t;
}
const URL_ = `${BASE}/procurements/${R}/quotes?series=${S}&version=${V1}`;
const ready = `!!document.querySelector('[data-testid="review-progress"]') && Object.keys(document.querySelector('[data-testid="review-progress"] button, [data-testid="review-progress"]')).some((k) => k.startsWith("__reactFiber")) && !!document.querySelector("[data-fact-path]")`;
const row = (path) => `document.querySelector('[data-fact-path="${path}"]')`;
const progress = (t) => t.eval(`(() => { const p = document.querySelector('[data-testid="review-progress"]'); return p ? [Number(p.dataset.done), Number(p.dataset.total)] : null; })()`);

const profile = mkdtempSync(join(tmpdir(), "tp-review-compact-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  // A new MOCK run of version 1 (API, real session): every value pending again.
  const res = await authedFetch(BASE, st.buyer, `/api/procurements/${R}/quotes/${S}/versions/${V1}/extractions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: randomUUID(), rerun: true }) });
  const run = (await res.json()).run;
  check("setup: new MOCK run of v1 through the API (not reviewed yet)", res.status === 201 && run.mode === "MOCK" && reviews(run.id).length === 0, `HTTP ${res.status}`);

  await signInBrowser(PORT, BASE, st.buyer);
  const A = await openTab();
  await A.send("Page.navigate", { url: URL_ });
  await A.waitFor(`document.readyState === "complete" && ${ready}`, 60000);
  await sleep(800);
  check("on load no row takes keyboard focus (no jump)", await A.eval(`document.activeElement === document.body || document.activeElement === null`), await A.eval(`document.activeElement?.outerHTML?.slice(0, 80) ?? ""`));
  const [d0, n0] = await progress(A);
  check(`progress starts at Reviewed 0 of ${n0}; no compact row yet`, d0 === 0 && n0 > 0 && !(await A.eval(`!!document.querySelector("[data-compact]")`)));

  // Next to review → focus on the first pending row's first action, row on screen.
  await A.click(`document.querySelector('[data-testid="review-next"]')`);
  await sleep(400);
  const f1 = await A.eval(`(() => { const a = document.activeElement; const r = a?.closest("[data-pending-row]"); const b = r?.getBoundingClientRect(); return { inPending: !!r, text: a?.innerText ?? "", path: r?.dataset.factPath ?? null, onScreen: !!b && b.top >= 0 && b.bottom <= innerHeight, outline: a ? getComputedStyle(a).outlineStyle : "" }; })()`);
  check("Next to review → focus on the first pending row's action (on screen)", f1.inPending && f1.onScreen && /Confirm|Choose|Save/.test(f1.text), JSON.stringify(f1));

  // Keyboard confirm (Enter on the focused button) → compact row + progress +1.
  const path1 = f1.path ?? (await A.eval(`document.querySelector("[data-pending-row][data-fact-path]")?.dataset.factPath`));
  if (f1.path === null) await A.click(`document.querySelector('[data-pending-row] [data-testid], [data-pending-row] button')`);
  else await A.enter();
  await A.waitFor(`${row(path1)}?.hasAttribute("data-compact")`, 15000).catch(() => {});
  const [d1] = await progress(A);
  check("Enter on Confirm → row becomes one compact line; progress +1; one review row stored", (await A.eval(`${row(path1)}?.hasAttribute("data-compact")`)) && d1 === 1 && reviews(run.id).length === 1, `${path1} · ${d1}`);
  await A.shot("01-first-compact");

  // Source toggle.
  const src = `${row(path1)}.querySelector('[data-testid="show-source"]')`;
  check("compact row: Source collapsed (aria-expanded=false), no excerpt shown", (await A.eval(`${src}.getAttribute("aria-expanded")`)) === "false" && !(await A.eval(`!!${row(path1)}.querySelector(".excerpt")`)));
  await A.click(src);
  await A.waitFor(`${src}.getAttribute("aria-expanded") === "true"`, 5000);
  check("Source → expanded: value check + quote line excerpt visible (aria-controls points at it)", (await A.eval(`!!${row(path1)}.querySelector(".excerpt q")`)) && (await A.eval(`!!document.getElementById(${src}.getAttribute("aria-controls"))`)));

  // Review again → full block, focus inside the row; Keep my review → compact, focus on Review again.
  await A.click(`${row(path1)}.querySelector('[data-testid="review-again"]')`);
  await A.waitFor(`!${row(path1)}.hasAttribute("data-compact")`, 5000);
  const f2 = await A.eval(`(() => { const a = document.activeElement; return { inRow: !!a?.closest('[data-fact-path="${path1}"]'), text: a?.innerText ?? "" }; })()`);
  check("Review again → full row with the 'new entry' note; focus moves to the row's first action", f2.inRow && (await A.eval(`${row(path1)}.innerText.includes("stored as a new entry")`)), JSON.stringify(f2));
  const keep = `[...${row(path1)}.querySelectorAll("button")].find((b) => b.innerText === "Keep my review")`;
  await A.click(keep);
  await A.waitFor(`${row(path1)}.hasAttribute("data-compact")`, 5000);
  const f3 = await A.eval(`document.activeElement?.dataset?.testid === "review-again" && !!document.activeElement.closest('[data-fact-path="${path1}"]')`);
  check("Keep my review → compact again, no request sent, focus back on Review again", f3 && reviews(run.id).length === 1);

  // Conflict from a stale tab: B loads, A confirms field X, B confirms X → refused, error stays visible (row not compacted).
  const B = await openTab();
  await B.send("Page.navigate", { url: URL_ });
  await B.waitFor(`document.readyState === "complete" && ${ready}`, 60000);
  const path2 = await B.eval(`document.querySelector("[data-pending-row][data-fact-path]")?.dataset.factPath`);
  const confirmIn = (p) => `[...${row(p)}.querySelectorAll("button")].find((b) => b.innerText === "Confirm")`;
  await A.send("Page.reload");
  await A.waitFor(`document.readyState === "complete" && ${ready}`, 60000);
  await A.click(confirmIn(path2));
  await A.waitFor(`${row(path2)}?.hasAttribute("data-compact")`, 15000);
  const before = reviews(run.id).length;
  await B.click(confirmIn(path2));
  await B.waitFor(`!!${row(path2)}.querySelector('[role="alert"]')`, 15000);
  check("stale second tab confirms the same field → conflict message stays visible in that row; no extra review row", (await B.eval(`${row(path2)}.querySelector('[role="alert"]').innerText`)).includes("reviewed in another tab") && !(await B.eval(`${row(path2)}.hasAttribute("data-compact")`)) && reviews(run.id).length === before, `${path2}`);
  await B.shot("02-stale-conflict");

  // Pending rows stay full; Next to review jumps past the compacted rows.
  await A.click(`document.querySelector('[data-testid="review-next"]')`);
  await sleep(400);
  const f4 = await A.eval(`(() => { const r = document.activeElement?.closest("[data-pending-row]"); return r?.dataset.factPath ?? null; })()`);
  check("Next to review skips reviewed (compact) rows and lands on a pending one", f4 !== null && f4 !== path1 && f4 !== path2, String(f4));
  check("no console errors", A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].slice(0, 2).join(" | "));
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
