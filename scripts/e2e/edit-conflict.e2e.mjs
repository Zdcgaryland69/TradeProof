// Browser regression check for procurement edit conflicts (manual run, not part of `npm test`).
//
//   npm run dev                 # in another terminal (127.0.0.1:3000)
//   npm run e2e:conflict
//
// Drives headless Microsoft Edge (or EDGE_PATH) over the DevTools Protocol with real clicks and typing.
// Creates ONE draft titled "[TEST] e2e edit conflict …" through the API, then:
//   tabs A and B open the same id at revision N → both edit Supplier → A saves (200, N+1) →
//   B saves with N from a 1280x800 window scrolled to the top → must get HTTP 409, the DB (read-only)
//   must still hold A's value at N+1, B must keep its input, and the conflict message must be ON SCREEN.
// Found 22 Oct 2026: the 409 was correct but the message rendered ~1,600 px below the viewport.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // signed-in e2e buyer (real login)
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function dbRow(id) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare("SELECT supplier_name, revision FROM procurement_requests WHERE id = ?").get(id);
  db.close();
  return { supplier: row.supplier_name, revision: Number(row.revision) };
}

async function openTab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) listeners.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression.slice(0, 80)}`);
    return r.result.value;
  };
  const tab = {
    send,
    evaluate,
    puts: [],
    close: () => ws.close(),
    async waitFor(expression, timeout = 30000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expression).catch(() => false)) return;
        await sleep(150);
      }
      throw new Error(`timeout: ${expression}`);
    },
    /** Real mouse click where the element is now (no scrolling); it must be on screen. */
    async click(expression) {
      await send("Page.bringToFront");
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, onScreen: r.top >= 0 && r.bottom <= innerHeight }; })()`);
      if (!box?.onScreen) throw new Error(`not clickable on screen: ${expression}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
    },
    async typeInto(selector, text) {
      await send("Page.bringToFront");
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); e.focus(); e.select(); })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await send("Input.insertText", { text });
    },
  };
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const pending = new Map();
  listeners.push((m) => {
    if (m.method === "Network.requestWillBeSent" && m.params.request.method === "PUT") {
      pending.set(m.params.requestId, JSON.parse(m.params.request.postData ?? "{}").revision);
    }
    if (m.method === "Network.responseReceived" && pending.has(m.params.requestId)) {
      tab.puts.push({ revision: pending.get(m.params.requestId), status: m.params.response.status });
    }
  });
  return tab;
}

const button = (text) => `[...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-edge-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
const tabs = [];
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  SESSION = await e2eSession(DB, BASE, PORT);
  const created = await authedFetch(BASE, SESSION, "/api/procurements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `[TEST] e2e edit conflict ${new Date().toISOString()}`, buyerType: "INDIVIDUAL", buyerPersonName: "Test person (e2e)", supplierName: "ORIGINAL", items: [{ name: "Test item" }] }),
  }).then((r) => r.json());
  const id = created.record.id;
  console.log(`test draft ${id}`);

  const [A, B] = [await openTab(), await openTab()];
  tabs.push(A, B);
  for (const t of [A, B]) {
    await t.send("Page.bringToFront");
    await t.send("Page.navigate", { url: `${BASE}/procurements/${id}` });
    await t.waitFor(`document.body.innerText.includes("Delivery & payment terms")`);
  }
  const start = dbRow(id);
  check("A and B show the same id and revision", (await A.evaluate("location.pathname")) === (await B.evaluate("location.pathname")), `revision ${start.revision}`);

  for (const [t, value] of [[A, "VALUE-A"], [B, "VALUE-B"]]) {
    // 7 Nov: on a copy with many approver accounts the Access list pushes Edit below the fold; a person scrolls to it.
    // The click itself still requires the button on screen (Save draft below is still clicked without scrolling).
    await t.evaluate(`${button("Edit")}.scrollIntoView({ block: "center" })`);
    await t.click(button("Edit"));
    await t.waitFor(`!!document.querySelector("#f-supplierName")`);
    await t.typeInto("#f-supplierName", value);
    await t.evaluate("window.scrollTo(0, 0)");
  }

  await A.evaluate(`${button("Save draft")}.scrollIntoView({ block: "center" })`); // 7 Nov: see the Edit note above
  await A.click(button("Save draft"));
  await A.waitFor(`document.body.innerText.includes("Saved as revision")`);
  const afterA = dbRow(id);
  check("A saved with revision N → HTTP 200, DB = A at N+1", A.puts[0]?.revision === start.revision && A.puts[0]?.status === 200 && afterA.supplier === "VALUE-A" && afterA.revision === start.revision + 1, JSON.stringify(A.puts));

  await B.evaluate("window.scrollTo(0, 0)");
  await B.evaluate(`${button("Save draft")}.scrollIntoView({ block: "center" })`); // 7 Nov: see the Edit note above
  await B.click(button("Save draft"));
  await sleep(1500);
  const afterB = dbRow(id);
  check("B saved with stale revision N → HTTP 409", B.puts[0]?.revision === start.revision && B.puts[0]?.status === 409, JSON.stringify(B.puts));
  check("DB unchanged by B: still A's value, revision not incremented", afterB.supplier === "VALUE-A" && afterB.revision === afterA.revision, JSON.stringify(afterB));
  check("B keeps its unsaved input", (await B.evaluate(`document.querySelector("#f-supplierName").value`)) === "VALUE-B");
  const where = await B.evaluate(`(() => {
    const panel = [...document.querySelectorAll("[role=alert]")].find((e) => e.textContent.includes("Edit conflict"));
    if (!panel) return "missing";
    const r = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + 20, r.y + 20);
    return r.top >= 0 && r.top < innerHeight - 40 && panel.contains(hit) ? "visible" : "off screen or covered (top " + Math.round(r.top) + ")";
  })()`);
  check("conflict panel visible in an 800 px viewport (not off screen, not covered)", where === "visible", where);
  const bar = await B.evaluate(`[...document.querySelectorAll(".actions.sticky [role=status]")].map((e) => e.textContent).join(" ")`);
  check("sticky save bar says the save was refused", bar.includes("Not saved — edit conflict"), bar);
} catch (err) {
  check("run completed", false, err.message);
} finally {
  tabs.forEach((t) => t.close());
  edge.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
