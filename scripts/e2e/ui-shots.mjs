// UI review screenshots (7 Nov; manual tool, not a test). Page views of one record on a database COPY, as the buyer and
// the approver kept by `chain.e2e.mjs --ui-prep` (<copy>.e2e-ui-sessions.json: cookies of throwaway test accounts, no
// password). Same record, roles and window sizes before and after a design change, so shots compare 1:1.
//
//   E2E_DB=<copy> node scripts/e2e/ui-shots.mjs <label> [--states]
//     <label>    output folder data/ux-review-2026-11-07/<label>/ (Git-ignored)
//     --states   after the main-flow shots: the approver ticks the confirmation and approves (real clicks) → shots
//                "active"; the buyer pays in MOCK step by step, waiting for each status (real clicks) → shots "paid";
//                version 1's approval page → shots "older-version". MOCK copy only; refuses a non-MOCK payment panel.
// Viewports 1280x800 and 390x844. Per page: first screen + full page; report: page height, horizontal overflow,
// console errors, failed (5xx) requests.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eDb, signInBrowser } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const label = process.argv[2] ?? "shots";
const OUT = join(process.cwd(), "data", "ux-review-2026-11-07", label);
mkdirSync(OUT, { recursive: true });
const st = JSON.parse(readFileSync(`${DB}.e2e-ui-sessions.json`, "utf8"));
const { request: R, series: S, v1: V1, v2: V2, run1, run2, draft: D } = st.ids;
const PORT = 9300 + Math.floor(Math.random() * 90);
const SIZES = [[1280, 800], [390, 844]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];

async function tab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const w = new Map();
  const t = { errors: [], failed: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) {
      w.get(m.id)(m.result ?? { error: m.error });
      w.delete(m.id);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") t.errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 200) ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") t.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200));
    if (m.method === "Network.responseReceived" && m.params.response.status >= 500) t.failed.push(`${m.params.response.status} ${m.params.response.url}`);
  };
  t.send = (method, params = {}) => new Promise((r) => { w.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })); });
  t.eval = async (expression) => (await t.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value;
  t.waitFor = async (expr, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await t.eval(expr).catch(() => false)) return true;
      await sleep(200);
    }
    throw new Error(`timeout: ${expr.slice(0, 140)}`);
  };
  t.click = async (expr) => {
    const box = await t.eval(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: e === hit || e.contains(hit) }; })()`);
    if (!box?.ok) throw new Error(`not clickable: ${expr.slice(0, 120)}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await t.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  for (const d of ["Page", "Runtime", "Network"]) await t.send(`${d}.enable`);
  return t;
}

async function shoot(t, name, url, settle) {
  for (const [width, height] of SIZES) {
    await t.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    t.errors.length = 0;
    t.failed.length = 0;
    await t.send("Page.navigate", { url });
    await t.waitFor(`document.readyState === "complete" && (${settle})`).catch(() => {});
    await sleep(900);
    const first = await t.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}-${width}-screen.png`), Buffer.from(first.data, "base64"));
    const dims = await t.eval("({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, cw: document.documentElement.clientWidth })");
    const full = await t.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(dims.h, 16000), scale: 1 } });
    writeFileSync(join(OUT, `${name}-${width}-full.png`), Buffer.from(full.data, "base64"));
    report.push({ name, width, pageHeight: dims.h, overflowX: dims.w > dims.cw + 1, errors: [...t.errors], failed: [...t.failed] });
  }
}

const profile = mkdtempSync(join(tmpdir(), "tp-ui-shots-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  const t = await tab();
  const U = {
    request: `${BASE}/procurements/${R}`,
    quotes: `${BASE}/procurements/${R}/quotes?series=${S}&version=${V2}`,
    compare: `${BASE}/procurements/${R}/quotes/compare?series=${S}&version=${V1}&run=${run1}`,
    draft: `${BASE}/procurements/${R}/quotes/drafts/${D}`,
    approval: `${BASE}/procurements/${R}/quotes/approval?series=${S}&version=${V2}&run=${run2}`,
    approvalV1: `${BASE}/procurements/${R}/quotes/approval?series=${S}&version=${V1}&run=${run1}`,
  };
  const summary = `!!document.querySelector('[data-testid="quote-approval-entry"]') && document.querySelector('[data-testid="quote-approval-entry"]').getAttribute("aria-busy") !== "true" && !!document.querySelector('[data-testid="review-progress"], .review-progress')`;
  const approvalReady = `!!document.querySelector('[data-testid="approval-status"]')`;
  const main = (who) => [
    [`${who}-request`, U.request, `!!document.querySelector("h1")`],
    [`${who}-quotes-v2`, U.quotes, summary],
    ...(who === "buyer" ? [[`${who}-compare-v1`, U.compare, `document.body.innerText.includes("Comparison basis")`], [`${who}-draft-v1`, U.draft, `!!document.querySelector('[data-testid="replies"]')`]] : []),
    [`${who}-approval-v2`, U.approval, approvalReady],
  ];
  for (const who of ["buyer", "approver"]) {
    await signInBrowser(PORT, BASE, st[who]);
    for (const [name, url, settle] of main(who)) await shoot(t, name, url, settle);
  }

  if (process.argv.includes("--states")) {
    // Active: the approver approves through the page.
    await signInBrowser(PORT, BASE, st.approver);
    await t.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await t.send("Page.navigate", { url: U.approval });
    await t.waitFor(`!!document.querySelector('[data-testid="approve"]') && Object.keys(document.querySelector('[data-testid="approve"]')).some((k) => k.startsWith("__reactFiber"))`);
    const pre = await t.eval(`[...document.querySelectorAll('[data-testid="confirm-list"] input')].map((b) => b.checked)`);
    if (pre.some(Boolean)) throw new Error("a confirmation was pre-ticked");
    for (let i = 0; i < pre.length; i++) await t.click(`document.querySelectorAll('[data-testid="confirm-list"] label')[${i}]`);
    await t.click(`document.querySelector('[data-testid="approve"]')`);
    await t.waitFor(`!!document.querySelector('[data-testid="approved-active"], [data-testid="approve-result"][data-state="ACTIVE"]')`);
    report.push({ action: `approver ticked ${pre.length} confirmation(s) (all started unticked) and approved` });
    await shoot(t, "approver-approval-v2-active", U.approval, approvalReady);
    await signInBrowser(PORT, BASE, st.buyer);
    await shoot(t, "buyer-quotes-v2-active", U.quotes, summary);
    await shoot(t, "buyer-approval-v2-active", U.approval, approvalReady);
    // Paid: the buyer pays in MOCK, one step at a time, waiting for each status.
    await t.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await t.send("Page.navigate", { url: U.approval });
    await t.waitFor(`!!document.querySelector('[data-testid="pay-start"]') && Object.keys(document.querySelector('[data-testid="pay-start"]')).some((k) => k.startsWith("__reactFiber"))`);
    if ((await t.eval(`document.querySelector('[data-testid="payment-section"]')?.dataset.mode`)) !== "MOCK") throw new Error("payment panel is not MOCK — refusing to pay");
    const step = async (testid, status) => {
      await t.click(`document.querySelector('[data-testid="${testid}"]')`);
      await t.waitFor(`document.querySelector('[data-testid="payment-status"]')?.dataset.status === "${status}" && !document.querySelector('[data-testid="payment-actions"] button:disabled')`);
    };
    await step("pay-start", "NEW");
    await step("pay-order", "ORDER_CREATED");
    await t.click(`document.querySelector('[data-testid="pay-mock-approve"]')`);
    await t.waitFor(`(document.querySelector('[data-testid="pay-message"]')?.innerText ?? "").includes("MOCK_APPROVED")`);
    await step("pay-capture", "PAID");
    report.push({ action: "buyer paid in MOCK: start → order → simulated approval → capture, each after the previous status" });
    await shoot(t, "buyer-approval-v2-paid", U.approval, approvalReady);
    await shoot(t, "buyer-quotes-v2-paid", U.quotes, summary);
    await shoot(t, "buyer-approval-v1-older", U.approvalV1, approvalReady);
    await signInBrowser(PORT, BASE, st.approver);
    await shoot(t, "approver-approval-v2-paid", U.approval, approvalReady);
  }
  await t.send("Page.close").catch(() => {});
} catch (e) {
  report.push({ action: "ERROR", error: e.message });
} finally {
  edge.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
  console.log(report.map((r) => (r.name ? `${r.name}@${r.width}: h=${r.pageHeight}${r.overflowX ? " OVERFLOW-X" : ""}${r.errors.length ? ` errors=${r.errors.length} ${r.errors[0]}` : ""}${r.failed.length ? ` failed=${r.failed.length}` : ""}` : `${r.action}${r.error ? `: ${r.error}` : ""}`)).join("\n"));
}
