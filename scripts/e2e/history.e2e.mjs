// Browser check for request revision history and unchanged saves (24 Oct follow-up; manual run, not part
// of `npm test`). Headed Microsoft Edge, 1366x768 (HEADLESS=1 for headless); screenshots in data/e2e-screens/.
//
//   npm run dev                          (any AI mode; no model is used here)
//   npm run e2e:history                  → Edit / Cancel / unchanged Save write nothing; a real change makes
//                                          revision 2; history list, old revision read-only, back to current;
//                                          an old (unowned) request is 404 for the signed-in buyer
//   (restart npm run dev)
//   npm run e2e:history -- --verify      → the same history is still there after the restart
//
// Creates one "[TEST] e2e history …" request; reads the DB read-only to cross-check.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // signed-in e2e buyer (real login)
const STATE = join(process.cwd(), "data", "e2e-history-state.json");
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const VERIFY = process.argv.includes("--verify");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const db = (fn) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return fn(c);
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
  const tab = { posts: [], puts: [], errors: [], dialogs: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent" && msg.params.request.method === "POST") tab.posts.push(msg.params.request.url);
    if (msg.method === "Network.requestWillBeSent" && msg.params.request.method === "PUT") tab.puts.push(msg.params.request.url);
    if (msg.method === "Runtime.exceptionThrown") tab.errors.push(msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") tab.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Page.javascriptDialogOpening") {
      tab.dialogs.push(msg.params.message);
      void send("Page.handleJavaScriptDialog", { accept: true });
    }
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
      throw new Error(`timeout: ${expression.slice(0, 140)}`);
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
    async typeInto(selector, text) {
      await send("Page.bringToFront");
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); e.focus(); e.select?.(); })()`);
      if (text) await send("Input.insertText", { text });
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

const button = (text) => `[...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled)`;
const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const api = async (method, path, body) => {
  const res = await authedFetch(BASE, SESSION, path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-history-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
const edge = spawn(EDGE, args, { stdio: "ignore" });
let A;
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  SESSION = await e2eSession(DB, BASE, PORT);
  A = await openTab();
  const putsOf = (id) => A.puts.filter((u) => u.includes(`/api/procurements/${id}`)).length;
  const dbRow = (id) => db((c) => ({ ...c.prepare("SELECT revision, updated_at FROM procurement_requests WHERE id = ?").get(id), history: c.prepare("SELECT count(*) n FROM procurement_request_revisions WHERE request_id = ?").get(id).n }));
  if (!VERIFY) {
    const created = await api("POST", "/api/procurements", {
      title: `[TEST] e2e history ${new Date().toISOString()}`,
      buyerType: "INDIVIDUAL",
      buyerPersonName: "Test person (e2e)",
      items: [{ name: "Insulated bottle", quantity: "500" }, { name: "Gift box", quantity: "500" }],
    });
    check("[TEST] request created (revision 1 + history row)", created.status === 201);
    const id = created.data.record.id;
    const start = dbRow(id);
    check("DB: revision 1, one history row", start.revision === 1 && start.history === 1);

    // 1. Edit, then Cancel: no request is sent, nothing changes.
    await A.goto(`${BASE}/procurements/${id}`, "Revision history");
    await A.click(button("Edit"));
    await A.waitFor(bodyHas("Editing"));
    await A.click(button("Cancel"));
    await A.waitFor(`!!document.querySelector('[data-testid="history-link"]')`);
    check("Edit + Cancel: no PUT sent", putsOf(id) === 0);
    // 2. Edit, Save with no change: "No changes to save.", same revision and updated_at, no history row.
    await A.click(button("Edit"));
    await A.waitFor(bodyHas("Editing"));
    await A.click(button("Save draft"));
    await A.waitFor(bodyHas("No changes to save."));
    const same = dbRow(id);
    check("unchanged Save: 'No changes to save.' and no 'Saved as revision'", !(await A.evaluate(bodyHas("Saved as revision"))));
    check("unchanged Save: revision, updated_at, history count unchanged", same.revision === 1 && same.updated_at === start.updated_at && same.history === 1);
    await A.shot("h1-no-changes");
    // 3. A real change: quantity of the first line.
    await A.click(button("Edit"));
    await A.waitFor(bodyHas("Editing"));
    await A.typeInto("#f-item-0-quantity", "600");
    await A.click(button("Save draft"));
    await A.waitFor(bodyHas("Saved as revision 2."));
    check("real change: revision 2 and a second history row", dbRow(id).revision === 2 && dbRow(id).history === 2);
    const refs = db((c) => c.prepare("SELECT id FROM procurement_request_items WHERE request_id = ? ORDER BY position").all(id)).map((i) => `IT-${i.id.slice(4, 12).toUpperCase()}`);

    // 4. History: list, Current, old revision read-only, back to current.
    await A.click(`document.querySelector('[data-testid="history-link"]')`);
    await A.waitFor(bodyHas("Stored revisions"));
    check("history lists Revision 2 (Current) and Revision 1", await A.evaluate(`[...document.querySelectorAll("[data-revision]")].map((e) => e.dataset.revision).join(",") === "2,1" && document.querySelector('[data-revision="2"]').textContent.includes("Current")`));
    check("history says it is complete since creation", await A.evaluate(bodyHas("Complete history")));
    check("current revision view offers the way to edit", await A.evaluate(bodyHas("Viewing revision 2") + " && " + bodyHas("Open the current revision to edit")));
    await A.click(`document.querySelector('[data-revision="1"]')`);
    await A.waitFor(bodyHas("Viewing revision 1"));
    check("old revision: read-only note, no edit entry", (await A.evaluate(bodyHas("Older revision — read only"))) && !(await A.evaluate(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Edit")`)));
    check("old revision shows the old quantity (500) and the same Item references", (await A.evaluate(`document.querySelector('[data-item-id] dd').textContent.includes("500")`)) && (await A.evaluate(`${JSON.stringify(refs)}.every((r) => document.body.innerText.includes(r))`)));
    check("'Saved by: not recorded' — no invented user", await A.evaluate(bodyHas("Saved by: not recorded")));
    await A.shot("h2-viewing-revision-1");
    check("viewing history sent no write", putsOf(id) === 2 && dbRow(id).history === 2);
    await A.click(`[...document.querySelectorAll("a")].find((a) => a.textContent.includes("Back to current revision"))`);
    await A.waitFor(`location.pathname === "/procurements/${id}" && document.body.innerText.includes("Revision history")`);
    check("Back to current revision → current detail page", true);

    // 5. The 24 Oct old request (history from its migration baseline, revision 9) has NO owner since access control
    //    (30 Oct; the owner decided not to assign old records), so a signed-in buyer must not see it. Its baseline
    //    display ("revisions 1–8 saved before history was recorded", nothing invented) stays covered by
    //    tests/history.test.ts on a temp DB; it is no longer reachable in the browser.
    const old = "pr_5e7759f6-7ed8-4ca7-b04b-c34c32e198ac";
    await A.send("Page.navigate", { url: `${BASE}/procurements/${old}/history` });
    await A.waitFor(`document.readyState === "complete"`);
    await sleep(300);
    check("old unowned request: its history page → 404 for this buyer (not assigned by the owner's decision)", await A.evaluate(`document.title.includes("404") || document.body.innerText.includes("could not be found")`));
    writeFileSync(STATE, JSON.stringify({ id, history: 2 }, null, 2));
  } else {
    const { id } = JSON.parse(readFileSync(STATE, "utf8"));
    await A.goto(`${BASE}/procurements/${id}/history?revision=1`, "Viewing revision 1");
    check("after restart: both revisions still listed", await A.evaluate(`[...document.querySelectorAll("[data-revision]")].map((e) => e.dataset.revision).join(",") === "2,1"`));
    check("after restart: revision 1 still shows quantity 500", await A.evaluate(`document.querySelector('[data-item-id] dd').textContent.includes("500")`));
    check("after restart: DB unchanged (revision 2, 2 history rows)", dbRow(id).revision === 2 && dbRow(id).history === 2);
  }
  check("no page errors", A.errors.length === 0, A.errors.join(" | "));
} catch (err) {
  check("script completed", false, err.message);
  if (A) await A.shot("zz-failure").catch(() => {});
} finally {
  A?.close();
  edge.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}
