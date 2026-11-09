// Browser acceptance check for 24 Oct (manual run, not part of `npm test`). Real clicks and typing in a
// NORMAL (headed) Microsoft Edge window, 1366x768; set HEADLESS=1 to run headless. Screenshots go to
// data/e2e-screens/ (Git-ignored). No real AI model and no PayPal call is involved.
//
// Signed in (31 Oct): runs ONLY on a database COPY (E2E_DB; the dev server uses TRADEPROOF_DB_PATH=<same copy>), as a
// throwaway e2e buyer signed in through the real login (scripts/e2e/lib/e2e-auth.mjs); writes carry the CSRF header.
//
//   Phase 1 — dev server WITHOUT AI configuration (AI_PROVIDER set to a blank, so .env.local's value is not used):
//     $env:AI_PROVIDER=" "; $env:TRADEPROOF_DB_PATH="<copy>"; npm run dev
//     $env:E2E_DB="<copy>"; npm run e2e:extraction  → buyer type form (Individual), Request ID + Item references,
//       copy full item id, reorder keeps references, an old (unowned) request is 404 for this buyer,
//       quote v1 → extraction panel says "No AI model configured", Run is disabled, no POST is sent.
//   Phase 2 — restart the dev server with the MOCK model (canned SYNTHETIC output, not an AI):
//     $env:AI_PROVIDER="mock"; $env:TRADEPROOF_DB_PATH="<copy>"; npm run dev
//     npm run e2e:extraction -- --mock              → MOCK banner, run, evidence shown, re-run needs consent,
//       confirm supplier number, v2 (mixed sample) has no inherited result and fails honestly (no fixture).
//     Phase 2 continues as the same e2e buyer (session kept next to the copy, no password stored).
//
// Creates "[TEST] e2e extraction …" requests only; reads the DB read-only to cross-check.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // signed-in e2e buyer (real login)
const STATE = `${DB}.e2e-extraction-state.json`; // next to the copy, outside the repository
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const MOCK = process.argv.includes("--mock");
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
  const tab = { posts: [], errors: [], dialogs: [] };
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
const read = (f) => readFileSync(join("samples", "synthetic", f), "utf8").replace(/\r\n/g, "\n");

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-extraction-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
const edge = spawn(EDGE, args, { stdio: "ignore" });
let A;
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  // Phase 1 signs in a fresh e2e buyer; phase 2 continues as the same buyer (it owns the phase-1 request).
  SESSION = await e2eSession(DB, BASE, PORT, { reuse: MOCK });
  A = await openTab();
  await A.send("Browser.grantPermissions", { origin: BASE, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});

  if (!MOCK) {
    // 1. New request as an Individual through the form.
    await A.goto(`${BASE}/procurements/new`, "Buyer type");
    const title = `[TEST] e2e extraction ${new Date().toISOString()}`;
    await A.typeInto("#f-title", title);
    await A.click(button("Save draft"));
    await A.waitFor(bodyHas("Choose Business or Individual."));
    check("save without buyer type → refused on screen", true);
    await A.click(`document.querySelector('input[name="buyerType"][value="INDIVIDUAL"]')`);
    await A.waitFor(`!!document.querySelector("#f-buyerPersonName")`);
    check("Individual shows 'Your name' and optional Company / Organization", await A.evaluate(bodyHas("Your name") + " && " + bodyHas("Company / Organization (optional)")));
    await A.typeInto("#f-buyerPersonName", "Tan Wei (test person)");
    await A.typeInto("#f-item-0-name", "Insulated bottle 500 ml");
    await A.typeInto("#f-item-0-quantity", "500");
    await A.click(button("+ Add item"));
    await A.typeInto("#f-item-1-name", "Gift box");
    await A.typeInto("#f-item-1-quantity", "500");
    await A.shot("01-new-individual");
    await A.click(button("Save draft"));
    await A.waitFor(bodyHas("Draft created"));
    const requestId = (await A.evaluate(`location.pathname`)).split("/").pop();
    check("detail: Request ID label + full id", await A.evaluate(`document.querySelector(".id-line").textContent.includes("Request ID") && document.querySelector(".id-line code").textContent === "${requestId}"`));
    check("detail: buyer type Individual + name", await A.evaluate(`document.querySelector('[data-testid="buyer-type"]').textContent === "Individual"`) && (await A.evaluate(bodyHas("Tan Wei (test person)"))));
    const items = db((c) => c.prepare("SELECT id, position FROM procurement_request_items WHERE request_id = ? ORDER BY position").all(requestId));
    const refs = items.map((i) => `IT-${i.id.slice(4, 12).toUpperCase()}`);
    check("detail: each item shows its IT- reference", await A.evaluate(`${JSON.stringify(refs)}.every((r) => document.body.innerText.includes(r))`), refs.join(", "));
    await A.click(`document.querySelector('[data-copy-id="${items[1].id}"]')`);
    await A.waitFor(bodyHas(`Full ID of ${refs[1]} copied.`));
    const clip = await A.evaluate(`navigator.clipboard.readText().catch((e) => "ERR " + e.message)`);
    check("copy item id puts the FULL id on the clipboard", clip === items[1].id, clip);
    await A.shot("02-detail-individual");

    // 2. Reorder: references move with their lines.
    await A.click(button("Edit"));
    await A.waitFor(bodyHas("Editing"));
    await A.click(`document.querySelector('[aria-label="Move item 2 up"]')`);
    await A.click(button("Save draft"));
    await A.waitFor(bodyHas("Saved as revision 2"));
    const after = db((c) => c.prepare("SELECT id FROM procurement_request_items WHERE request_id = ? ORDER BY position").all(requestId)).map((i) => i.id);
    check("reorder keeps ids (order swapped, same ids)", JSON.stringify(after) === JSON.stringify([items[1].id, items[0].id]));
    const shownRefs = await A.evaluate(`[...document.querySelectorAll(".items .item-ref .ref")].map((e) => e.textContent)`);
    check("detail shows references in the new order", JSON.stringify(shownRefs) === JSON.stringify([refs[1], refs[0]]), shownRefs.join(", "));

    // 3. Old requests (before v7, buyer type not recorded) have NO owner since access control (30 Oct; the owner
    //    decided not to assign old records), so a signed-in buyer must not see one. The "Buyer type not recorded"
    //    display itself is no longer reachable in the browser.
    const old = db((c) => c.prepare("SELECT id FROM procurement_requests WHERE buyer_type IS NULL AND id NOT IN (SELECT request_id FROM procurement_owners) ORDER BY created_at LIMIT 1").get());
    await A.send("Page.navigate", { url: `${BASE}/procurements/${old.id}` });
    await A.waitFor(`document.readyState === "complete"`);
    await sleep(300);
    check("old unowned request (buyer type not recorded) → 404 for this buyer", await A.evaluate(`document.title.includes("404") || document.body.innerText.includes("could not be found")`));
    await A.shot("03-old-request-404");

    // 4. A quote version: extraction panel without configuration.
    const zh = read("supplier-quote-zh.synthetic.md");
    const saved = await api("POST", `/api/procurements/${requestId}/quotes`, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 2,
      name: "[TEST] e2e extraction — SYNTHETIC zh sample",
      rawText: zh,
      source: "TEST_FIXTURE",
      sourceNote: "samples/synthetic/supplier-quote-zh.synthetic.md (e2e)",
    });
    check("quote v1 saved", saved.status === 201, String(saved.status));
    const seriesId = saved.data.series.id;
    const v1 = saved.data.version.id;
    A.posts.length = 0;
    await A.goto(`${BASE}/procurements/${requestId}/quotes?series=${seriesId}&version=${v1}`, "AI extraction");
    await A.waitFor(`!!document.querySelector('[data-testid="extraction-not-configured"]')`);
    // The names the server reports as missing (all three with an empty .env.local; only AI_PROVIDER when it is blanked
    // in the process environment while .env.local holds a model and key).
    const missing = (await api("GET", `/api/procurements/${requestId}/quotes/${seriesId}/versions/${v1}/extractions`)).data.config?.missing ?? [];
    check("panel: 'No AI model configured' + missing variable names", missing.length > 0 && (await A.evaluate(bodyHas(missing.join(", ")))), missing.join(", "));
    check("panel: Run button disabled", await A.evaluate(`document.querySelector('[data-testid="run-extraction"]').disabled === true`));
    check("snapshot (v2) shows buyer + IT- references", (await A.evaluate(`document.querySelector('[data-testid="snapshot-buyer"]').textContent.includes("Individual")`)) && (await A.evaluate(bodyHas(refs[0]))));
    await A.evaluate(`document.querySelector('[data-testid="extraction-panel"]').scrollIntoView({ block: "start" })`);
    await sleep(300);
    await A.shot("04-extraction-not-configured");
    check("no POST sent by loading the page", A.posts.filter((u) => u.includes("/extractions")).length === 0);
    check("no extraction rows created", db((c) => c.prepare("SELECT count(*) n FROM quote_extraction_runs WHERE version_id = ?").get(v1).n) === 0);
    writeFileSync(STATE, JSON.stringify({ requestId, seriesId, v1, refs, itemIds: after }, null, 2));
  } else {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    const { requestId, seriesId, v1 } = state;
    await A.goto(`${BASE}/procurements/${requestId}/quotes?series=${seriesId}&version=${v1}`, "AI extraction");
    await A.waitFor(`!!document.querySelector('[data-testid="mock-banner"]')`);
    check("MOCK banner says it is not an AI result", await A.evaluate(bodyHas("not an AI result")));
    A.posts.length = 0;
    await A.click(button("Run extraction (MOCK)"));
    await A.waitFor(`!!document.querySelector('[data-testid="extraction-notice"]')`);
    // 5 Nov: the notice appears before the panel re-reads the run list; wait for the run's values too (on a cold dev
    // compile the re-read took ~1.7 s and the next check read the page too early — stored run was SUCCEEDED).
    await A.waitFor(`!!document.querySelector('.run-view [data-fact-path="total"]')`);
    check("exactly one POST for one click", A.posts.filter((u) => u.endsWith("/extractions")).length === 1);
    check("run finished: excerpts found, review required", await A.evaluate(bodyHas("Finished — source excerpts found for all values; review required")));
    check("evidence shown with line number", await A.evaluate(`document.querySelector('[data-fact-path="total"]').textContent.includes("line 20") && document.querySelector('[data-fact-path="total"]').textContent.includes("11,760.00")`));
    check("packaging fee amount unknown, to be confirmed", await A.evaluate(`document.querySelector('[data-fact-path="fees[0].amount"]').dataset.check === "NOT_STATED" && document.querySelector('[data-fact-path="fees[0].statedAs"]').textContent.includes("To be confirmed")`));
    check("cost overview counts unknown fees, not 0", await A.evaluate(`document.querySelector('[data-testid="cost-summary"]').textContent.includes("not counted (not 0)")`));
    check("item match proposed (not auto-confirmed)", await A.evaluate(`document.querySelector('[data-match-status]').dataset.matchStatus === "PROPOSED" && !document.querySelector(".match .review")`));
    check("run labelled MOCK in history", await A.evaluate(`[...document.querySelectorAll(".run-list li")].every((li) => li.textContent.includes("MOCK"))`));
    await A.shot("05-mock-run-result");

    // Re-run needs explicit consent (dialog), then a second row exists.
    A.dialogs.length = 0;
    await A.click(button("Run again (new model call)"));
    await A.waitFor(`document.querySelectorAll(".run-list li").length === 2`);
    check("re-run asked for confirmation first", A.dialogs.some((d) => d.includes("new model call")));

    // Confirm the supplier quote number candidate.
    await A.click(`document.querySelector('[data-fact-path="supplierQuoteNumbers[0]"] .review-actions button')`);
    await A.waitFor(`document.querySelector('[data-testid="supplier-number"]').textContent.includes("QT-DEMO-2026-118")`);
    check("supplier number: confirmed by user, stored as USER_CONFIRMED", db((c) => c.prepare("SELECT origin FROM quote_version_supplier_refs WHERE version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(v1)).origin === "USER_CONFIRMED");
    await A.click(`document.querySelector('.match button:not(.link-button)')`);
    await A.waitFor(`!!document.querySelector(".match .review")`);
    check("item match confirmed by the user", await A.evaluate(`document.querySelector(".match .review").textContent.includes("Matched by you to IT-")`));
    await A.shot("06-mock-reviewed");

    // 5 Nov review controls: progress count, a reviewed row keeps its decision (no second Confirm / Save match), one
    // stored row per decision, "Next to review" moves focus to a pending row.
    const progress = await A.evaluate(`(() => { const p = document.querySelector('[data-testid="review-progress"]'); return p ? { done: +p.dataset.done, total: +p.dataset.total, text: p.innerText } : null; })()`);
    check("review progress shows 'Reviewed 2 of N' after the supplier number and the match", !!progress && progress.done === 2 && progress.total > 2 && progress.text.includes(`Reviewed 2 of ${progress.total}`), JSON.stringify(progress));
    const numRow = `document.querySelector('[data-fact-path="supplierQuoteNumbers[0]"]')`;
    check(
      "confirmed value: no second Confirm button, 'Review again' instead; match: no 'Save match', 'Review again' instead",
      (await A.evaluate(`![...${numRow}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Confirm') && !!${numRow}.querySelector('[data-testid="review-again"]')`)) &&
        (await A.evaluate(`![...document.querySelectorAll('.match button')].some((b) => b.textContent.trim() === 'Save match') && !!document.querySelector('.match [data-testid="review-again"]')`)),
    );
    const latestRun = db((c) => c.prepare("SELECT id FROM quote_extraction_runs WHERE version_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(v1)).id;
    check(
      "one stored review row each for the supplier number and the match",
      db((c) => c.prepare("SELECT count(*) n FROM quote_extraction_reviews WHERE extraction_id = ? AND field_path = 'supplierQuoteNumbers[0]'").get(latestRun).n) === 1 &&
        db((c) => c.prepare("SELECT count(*) n FROM quote_extraction_reviews WHERE extraction_id = ? AND field_path = 'items[0].match'").get(latestRun).n) === 1,
    );
    await A.click(`document.querySelector('[data-testid="review-next"]')`);
    await sleep(400);
    check(
      "'Next to review' focuses a button in a pending row",
      await A.evaluate(`(() => { const a = document.activeElement; return a?.tagName === 'BUTTON' && !!a.closest('[data-pending-row]'); })()`),
    );
    await A.click(`${numRow}.querySelector('[data-testid="review-again"]')`);
    check("'Review again' says a new review changes the approval basis; nothing written by opening it", (await A.evaluate(`${numRow}.innerText.includes('changes the basis')`)) && db((c) => c.prepare("SELECT count(*) n FROM quote_extraction_reviews WHERE extraction_id = ? AND field_path = 'supplierQuoteNumbers[0]'").get(latestRun).n) === 1);
    await A.shot("06b-review-controls");

    // v2 (mixed sample): no inherited result; MOCK fails honestly (no canned output for this text).
    const v2 = await api("POST", `/api/procurements/${requestId}/quotes/${seriesId}/versions`, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 2,
      expectedLatestVersionId: v1,
      rawText: read("supplier-quote-mixed-fees.synthetic.md"),
      source: "TEST_FIXTURE",
      sourceNote: "samples/synthetic/supplier-quote-mixed-fees.synthetic.md (e2e)",
    });
    check("quote v2 saved", v2.status === 201, String(v2.status));
    await A.goto(`${BASE}/procurements/${requestId}/quotes?series=${seriesId}&version=${v2.data.version.id}`, "AI extraction");
    await A.waitFor(bodyHas("Not run for this version yet"));
    check("v2 starts with no extraction (nothing inherited from v1)", true);
    await A.click(button("Run extraction (MOCK)"));
    await A.waitFor(`!!document.querySelector('[data-testid="run-failed"]')`);
    check("MOCK on unknown text → shown as failure, no result", await A.evaluate(bodyHas("MOCK_NO_FIXTURE")) && !(await A.evaluate(`!!document.querySelector(".result")`)));
    await A.shot("07-v2-mock-no-fixture");
    await A.goto(`${BASE}/procurements/${requestId}/quotes?series=${seriesId}&version=${v1}`, "AI extraction");
    await A.waitFor(bodyHas("Version 2 has been saved since"));
    check("v1 panel says a newer version exists and its results are not used for it", true);
    await A.shot("08-v1-newer-version-note");
    const v = db((c) => c.prepare("SELECT raw_text_sha256 FROM quote_versions WHERE id = ?").get(v1));
    check("v1 hash unchanged", v.raw_text_sha256 === "e9765ed4d595bb3f469642b17a09b2a854a21f36d6200cc79359066944d70ba5");
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
