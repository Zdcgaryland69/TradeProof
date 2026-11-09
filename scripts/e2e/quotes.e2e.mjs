// Browser acceptance check for quote versions (manual run, not part of `npm test`).
//
//   npm run dev                                  # in another terminal (127.0.0.1:3000)
//   npm run e2e:quotes                           # phase 1: creates data, writes data/e2e-quotes-state.json
//   (restart npm run dev)
//   npm run e2e:quotes -- --verify               # phase 2: re-checks the same records after the restart
//
// Drives headless Microsoft Edge (or EDGE_PATH) over the DevTools Protocol with real clicks and typing in a
// 1366x768 window. Creates ONE "[TEST] e2e quotes …" procurement draft through the API, then in the UI:
//   empty state → Load demo (Chinese sample) → preview → save v1 (DEMO_SAMPLE) →
//   add v2 (Test data) whose first response is dropped by the browser → Save again returns the original v2 →
//   two tabs revise v2: A saves v3, B gets VERSION_CONFLICT (visible, text kept) →
//   switch back to v1 → edit the request (rename + reorder items: ids kept) → v1 still shows its old snapshot
//   with the "request updated" note → B saves on v3 → REQUEST_CHANGED → links to the new revision → v4 →
//   v5 supplement to v1. Pasted HTML must stay text. The DB is read read-only to cross-check.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // signed-in e2e buyer (real login)
const STATE = join(process.cwd(), "data", "e2e-quotes-state.json"); // data/ is Git-ignored
const VERIFY = process.argv.includes("--verify");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function db(fn) {
  const conn = new DatabaseSync(DB, { readOnly: true });
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}
const versionsOf = (seriesId) =>
  db((c) => c.prepare("SELECT id, version_number, content_kind, supplements_version_id, source, raw_text, raw_text_sha256, request_revision, request_snapshot, revision_note FROM quote_versions WHERE series_id = ? ORDER BY version_number").all(seriesId));
const itemsOf = (requestId) => db((c) => c.prepare("SELECT id, position, name FROM procurement_request_items WHERE request_id = ? ORDER BY position").all(requestId));
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");

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
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression.slice(0, 100)}`);
    return r.result.value;
  };
  const tab = {
    send,
    evaluate,
    listeners,
    /** POSTs to the quote API: { status } or { failed: true } when the browser saw a network error. */
    posts: [],
    errors: [],
    close: () => ws.close(),
    async waitFor(expression, timeout = 30000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expression).catch(() => false)) return;
        await sleep(150);
      }
      throw new Error(`timeout: ${expression.slice(0, 120)}`);
    },
    async goto(url, readyText) {
      await send("Page.bringToFront");
      await send("Page.navigate", { url });
      await tab.waitFor(`document.readyState === "complete" && document.body.innerText.includes(${JSON.stringify(readyText)})`);
    },
    /** Scrolls the element into view, then a real mouse click at its centre (must be on screen and not covered). */
    async click(expression) {
      await send("Page.bringToFront");
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: r.top >= 0 && r.bottom <= innerHeight && (e === hit || e.contains(hit)) }; })()`);
      if (!box?.ok) throw new Error(`not clickable on screen: ${expression.slice(0, 120)}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
    },
    async typeInto(selector, text) {
      await send("Page.bringToFront");
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); e.focus(); e.select(); })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      if (text) await send("Input.insertText", { text });
    },
    /** True when the element is inside the viewport and not covered. */
    async visible(expression) {
      return evaluate(`(() => { const e = ${expression}; if (!e) return false; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + Math.min(10, r.height / 2)); return r.top >= 0 && r.top < innerHeight - 20 && (e === hit || e.contains(hit)); })()`);
    },
  };
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  const pending = new Map();
  listeners.push((m) => {
    if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && m.params.request.url.includes("/quotes")) pending.set(m.params.requestId, true);
    if (m.method === "Network.responseReceived" && pending.has(m.params.requestId)) tab.posts.push({ status: m.params.response.status });
    if (m.method === "Network.loadingFailed" && pending.has(m.params.requestId)) tab.posts.push({ failed: true });
    if (m.method === "Runtime.exceptionThrown") tab.errors.push(m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") tab.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  return tab;
}

const button = (text) => `[...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled)`;
const link = (text) => `[...document.querySelectorAll("a")].find((a) => a.textContent.includes(${JSON.stringify(text)}))`;
const tabFor = (n) => `[...document.querySelectorAll(".version-tab")].find((b) => b.dataset.version === "${n}")`;
const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const shownText = `[...document.querySelectorAll(".version-view .quote-text .lt")].map((e) => e.textContent).join("\\n")`;

const TEST_V2 = "[TEST] revised quote text — not a real supplier document\n单价 USD 3.30 / pc\n<script>window.__xss = 1</script><img src=x onerror=\"window.__xss = 2\">\n\n  indented line kept  ";

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-quotes-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
const tabs = [];
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  SESSION = await e2eSession(DB, BASE, PORT);

  if (VERIFY) {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    const A = await openTab();
    tabs.push(A);
    await A.goto(`${BASE}/procurements/${state.requestId}/quotes?series=${state.seriesId}&version=${state.v1}`, "Quote series");
    await A.waitFor(`!!document.querySelector(".version-view[data-version-id='${state.v1}']")`);
    check("after restart: v1 opens with the same text", (await A.evaluate(shownText)) === state.v1Text);
    check("after restart: v1 snapshot still revision 1 with the update note", (await A.evaluate(bodyHas("saved linked to revision 1"))) && (await A.evaluate(bodyHas(`now revision ${state.requestRevision}`))));
    const versions = versionsOf(state.seriesId);
    check("after restart: same 5 versions, same ids and order", JSON.stringify(versions.map((v) => v.id)) === JSON.stringify(state.versionIds));
    check("after restart: every stored hash matches its stored text", versions.every((v) => v.raw_text_sha256 === sha(v.raw_text)));
    check("after restart: v1 hash unchanged since phase 1", versions[0].raw_text_sha256 === state.v1Hash);
    check("after restart: item ids unchanged", JSON.stringify(itemsOf(state.requestId).map((i) => i.id)) === JSON.stringify(state.itemIds));
    await A.click(tabFor(4));
    await A.waitFor(`!!document.querySelector(".version-view[data-version-id='${state.versionIds[3]}']")`);
    check("after restart: v4 linked to revision 2 shows no update note", (await A.evaluate(bodyHas("The request is still at this revision."))));
    check("no page errors", A.errors.length === 0, A.errors.join(" | "));
  } else {
    const created = await authedFetch(BASE, SESSION, "/api/procurements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `[TEST] e2e quotes ${new Date().toISOString()}`,
        buyerType: "BUSINESS",
        buyerCompany: "Test buyer (e2e)",
        items: [
          { name: "Insulated bottle", quantity: "500", unit: "pcs", material: "304 stainless steel" },
          { name: "Gift box", quantity: "500", unit: "pcs" },
        ],
      }),
    }).then((r) => r.json());
    const id = created.record.id;
    const itemIds0 = created.record.items.map((i) => i.id);
    console.log(`test draft ${id}`);

    const A = await openTab();
    tabs.push(A);
    await A.goto(`${BASE}/procurements/${id}`, "Quotes 报价 (0)");
    check("detail page shows an empty Quotes section", await A.evaluate(bodyHas("No supplier quote saved yet")));
    await A.click(link("Add a quote"));
    await A.waitFor(bodyHas("No quotes saved for this request yet"));
    check("quotes page: empty state + composer open", await A.evaluate(`!!document.querySelector("#q-text")`));

    // v1 from Load demo (Chinese sample)
    await A.click(`document.querySelector("button[data-demo='zh']")`);
    const demoText = readFileSync(join("samples", "synthetic", "supplier-quote-zh.synthetic.md"), "utf8").replace(/\r\n/g, "\n");
    check("Load demo fills the editor with the sample text (not saved yet)", (await A.evaluate(`document.querySelector("#q-text").value`)) === demoText && versionsOf("none").length === 0);
    check("demo banner shown", await A.evaluate(bodyHas("SYNTHETIC / DEMO quote loaded")));
    await A.click(button("Preview"));
    await A.waitFor(bodyHas("Preview — not saved yet"));
    const previewText = await A.evaluate(`[...document.querySelectorAll(".preview .quote-text .lt")].map((e) => e.textContent).join("\\n")`);
    check("preview shows the text with line numbers outside the text", previewText === demoText && (await A.evaluate(`document.querySelector(".preview .quote-text").innerText.startsWith(">")`)));
    await A.click(button("Save version 1"));
    await A.waitFor(bodyHas("Saved as version 1"));
    const seriesId = await A.evaluate(`new URL(location.href).searchParams.get("series")`);
    let versions = versionsOf(seriesId);
    check("v1 saved: HTTP 201, DEMO_SAMPLE, text byte-identical, hash ok, linked to revision 1",
      A.posts.at(-1)?.status === 201 && versions.length === 1 && versions[0].source === "DEMO_SAMPLE" && versions[0].raw_text === demoText && versions[0].raw_text_sha256 === sha(demoText) && versions[0].request_revision === 1,
      JSON.stringify(A.posts));
    const v1 = versions[0];
    check("v1 snapshot holds the request with its item ids", JSON.stringify(JSON.parse(v1.request_snapshot).record.items.map((i) => i.id)) === JSON.stringify(itemIds0));

    // v2 (Test data): the browser drops the first response after the server handled it, then the user presses Save again.
    await A.click(button("+ Add revision"));
    await A.waitFor(`!!document.querySelector("#q-text")`);
    check("revision composer inherits name and supplier", await A.evaluate(bodyHas("Quote name and supplier are inherited")));
    await A.typeInto("#q-text", TEST_V2);
    await A.evaluate(`(() => { const s = document.querySelector("#q-source"); s.value = "TEST_FIXTURE"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await A.typeInto("#q-rev-note", "[TEST] supplier added freight");
    await A.click(button("Preview"));
    await A.waitFor(bodyHas("Preview — not saved yet"));
    await A.send("Fetch.enable", { patterns: [{ urlPattern: "*/quotes/*/versions", requestStage: "Response" }] });
    let dropped = 0;
    const dropper = (m) => {
      if (m.method === "Fetch.requestPaused") {
        dropped++;
        void A.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "ConnectionReset" });
      }
    };
    A.listeners.push(dropper);
    await A.click(button("Save as version 2"));
    await A.waitFor(bodyHas("Save failed"));
    A.listeners.splice(A.listeners.indexOf(dropper), 1);
    await A.send("Fetch.disable");
    versions = versionsOf(seriesId);
    check("lost response: server saved v2, browser saw a network failure, UI says not saved and keeps the input",
      dropped === 1 && versions.length === 2 && (await A.evaluate(`!!document.querySelector(".preview")`)) && (await A.visible(`[...document.querySelectorAll("[role=alert]")].find((e) => e.textContent.includes("Save failed"))`)));
    await A.click(button("Save as version 2"));
    await A.waitFor(bodyHas("Already saved as version 2"));
    versions = versionsOf(seriesId);
    check("retry with the same key → HTTP 200 REPLAYED, still exactly 2 versions", A.posts.at(-1)?.status === 200 && versions.length === 2, JSON.stringify(A.posts));
    check("v2 stored verbatim (HTML, blank line, indentation), TEST_FIXTURE, revision note kept",
      versions[1].raw_text === TEST_V2 && versions[1].source === "TEST_FIXTURE" && versions[1].revision_note === "[TEST] supplier added freight");
    check("pasted HTML is shown as text and never executed", (await A.evaluate(`window.__xss === undefined`)) && (await A.evaluate(shownText)) === TEST_V2 && (await A.evaluate(`document.querySelectorAll(".version-view img, .version-view script").length === 0`)));
    check("v2 view labels: latest saved — not accepted; user's revision note not verified", (await A.evaluate(bodyHas("Latest saved — not accepted"))) && (await A.evaluate(bodyHas("(written by the user; not verified)"))));

    // Two tabs revise v2 at the same time.
    const B = await openTab();
    tabs.push(B);
    await B.goto(`${BASE}/procurements/${id}/quotes?series=${seriesId}`, "Quote series");
    for (const [t, text] of [[A, "[TEST] tab A revision"], [B, "[TEST] tab B revision"]]) {
      await t.click(button("+ Add revision"));
      await t.waitFor(`!!document.querySelector("#q-text")`);
      await t.typeInto("#q-text", text);
      await t.evaluate(`(() => { const s = document.querySelector("#q-source"); s.value = "TEST_FIXTURE"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await t.click(button("Preview"));
      await t.waitFor(bodyHas("Preview — not saved yet"));
    }
    await A.click(button("Save as version 3"));
    await A.waitFor(bodyHas("Saved as version 3"));
    await B.click(button("Save as version 3"));
    await B.waitFor(bodyHas("Edit conflict: nothing was saved"));
    versions = versionsOf(seriesId);
    check("second tab → HTTP 409 VERSION_CONFLICT; v3 is tab A's text; nothing reordered", B.posts.at(-1)?.status === 409 && versions.length === 3 && versions[2].raw_text === "[TEST] tab A revision");
    check("conflict message visible in a 1366x768 window; tab B keeps its text",
      (await B.visible(`[...document.querySelectorAll("[role=alert]")].find((e) => e.textContent.includes("Edit conflict"))`)) &&
        (await B.evaluate(`[...document.querySelectorAll(".preview .quote-text .lt")].map((e) => e.textContent).join("\\n")`)) === "[TEST] tab B revision");

    // Back to v1 in tab A.
    await A.click(tabFor(1));
    await A.waitFor(`!!document.querySelector(".version-view[data-version-id='${v1.id}']")`);
    check("switch back to v1: original demo text and source", (await A.evaluate(shownText)) === demoText && (await A.evaluate(bodyHas("SYNTHETIC / DEMO sample"))));
    check("v1 snapshot: revision 1, request not yet changed", await A.evaluate(bodyHas("The request is still at this revision.")));

    // Edit the request: rename item 1, move item 2 up.
    await A.goto(`${BASE}/procurements/${id}`, "Quotes 报价 (1)");
    await A.click(button("Edit"));
    await A.waitFor(`!!document.querySelector("#f-item-0-name")`);
    await A.typeInto("#f-item-0-name", "Insulated bottle (500 ml)");
    await A.click(`document.querySelector("[aria-label='Move item 2 up']")`);
    await A.click(button("Save draft"));
    await A.waitFor(bodyHas("Saved as revision 2"));
    const items = itemsOf(id);
    check("request edit: revision 2; rename + reorder keep both item ids", JSON.stringify(items.map((i) => i.id)) === JSON.stringify([itemIds0[1], itemIds0[0]]) && items[1].name === "Insulated bottle (500 ml)");

    await A.goto(`${BASE}/procurements/${id}/quotes?series=${seriesId}&version=${v1.id}`, "Quote series");
    await A.waitFor(`!!document.querySelector(".version-view[data-version-id='${v1.id}']")`);
    check("v1 still shows the old snapshot (old item name, old order)",
      (await A.evaluate(`[...document.querySelectorAll(".snapshot-items > li > strong.pre")].map((e) => e.textContent).join("|")`)) === "Insulated bottle|Gift box");
    await A.evaluate(`document.querySelector("[data-testid=request-updated-note]")?.scrollIntoView({ block: "center" })`);
    check("update note visible: request now revision 2, this quote saved linked to revision 1",
      (await A.visible(`document.querySelector("[data-testid=request-updated-note]")`)) && (await A.evaluate(bodyHas("now revision 2"))) && (await A.evaluate(bodyHas("saved linked to revision 1"))));
    check("snapshot evidence boundary stated", await A.evaluate(bodyHas("does not mean the supplier received, accepted or promised to meet it")));
    check("stored v1 row unchanged after the request edit", JSON.stringify(versionsOf(seriesId)[0]) === JSON.stringify(v1));

    // Tab B (still on revision 1): re-base on v3 → request changed → link to revision 2 → v4.
    await B.click(button("Save mine as version 4"));
    await B.click(button("Save as version 4"));
    await B.waitFor(bodyHas("Request updated — nothing was saved"));
    check("tab B → HTTP 409 REQUEST_CHANGED, message visible, text kept",
      B.posts.at(-1)?.status === 409 && (await B.visible(`[...document.querySelectorAll("[role=alert]")].find((e) => e.textContent.includes("Request updated"))`)) && versionsOf(seriesId).length === 3);
    await B.click(button("Link to revision 2 instead"));
    await B.click(button("Save as version 4"));
    await B.waitFor(bodyHas("Saved as version 4"));
    versions = versionsOf(seriesId);
    check("v4 saved from tab B, linked to request revision 2", versions.length === 4 && versions[3].raw_text === "[TEST] tab B revision" && versions[3].request_revision === 2);

    // v5: supplement to v1.
    await B.click(button("+ Add revision"));
    await B.waitFor(`!!document.querySelector("#q-text")`);
    await B.click(`document.querySelector("input[name=q-kind][value=SUPPLEMENT]")`);
    await B.evaluate(`(() => { const s = document.querySelector("select[aria-label='Version this supplement adds to']"); s.value = ${JSON.stringify(v1.id)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await B.typeInto("#q-text", "[TEST] 补充：运费另计 RMB 300");
    await B.evaluate(`(() => { const s = document.querySelector("#q-source"); s.value = "TEST_FIXTURE"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await B.click(button("Preview"));
    await B.waitFor(bodyHas("Supplement / fragment to v1"));
    await B.click(button("Save as version 5"));
    await B.waitFor(bodyHas("Saved as version 5"));
    versions = versionsOf(seriesId);
    check("v5 saved as SUPPLEMENT to v1; the view says it does not replace v1",
      versions.length === 5 && versions[4].content_kind === "SUPPLEMENT" && versions[4].supplements_version_id === v1.id && (await B.evaluate(bodyHas("Supplement to version 1. It does not replace that version"))));
    check("every non-demo version is stored as explicit test data", versions.slice(1).every((v) => v.source === "TEST_FIXTURE"), versions.map((v) => v.source).join(","));
    check("no page errors in either tab", A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(" | "));

    writeFileSync(
      STATE,
      JSON.stringify({ requestId: id, seriesId, v1: v1.id, v1Text: demoText, v1Hash: v1.raw_text_sha256, versionIds: versions.map((v) => v.id), itemIds: items.map((i) => i.id), requestRevision: 2 }, null, 1),
    );
    console.log(`state written to ${STATE}; restart npm run dev, then run with --verify`);
  }
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
