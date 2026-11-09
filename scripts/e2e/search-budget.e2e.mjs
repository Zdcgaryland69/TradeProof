// Browser check for 25 Oct (manual run, not part of `npm test`): search on the request list, the new
// extraction wording (excerpt found / value check / your review), older results labelled with the rules they
// were checked with, and the API budget block. NORMAL (headed) Edge, 1366x768; HEADLESS=1 for headless.
//   npm run dev                               → npm run e2e:25oct            (budget "not configured")
//   $env:AI_PROVIDER="mock"; npm run dev      → npm run e2e:25oct -- --mock  (one MOCK re-run on a SYNTHETIC
//                                               version; labelled MOCK; never touches the LIVE budget)
// Reads the DB read-only; screenshots in data/e2e-screens/ (Git-ignored). No model API and no PayPal call.
//
// Signed in (31 Oct): runs ONLY on a database COPY (E2E_DB; the dev server uses TRADEPROOF_DB_PATH=<same copy>), as the
// e2e buyer kept next to the copy (real login). Run it after extraction.e2e.mjs (both phases) and the comparison setup
// on the same copy: the search then targets the buyer's OWN [TEST] records, and every count is the buyer's scope.
// The 25 Oct "older rules" result exists only on old records, which have no owner since access control (owner's
// decision) — those checks are reported as not reachable, not as passed; the display stays covered by unit tests.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
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

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-25oct-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
const edge = spawn(EDGE, args, { stdio: "ignore" });
let A;
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  const SESSION = await e2eSession(DB, BASE, PORT, { reuse: true });
  const OWNED = `(SELECT request_id FROM procurement_owners WHERE principal_id = ${JSON.stringify(SESSION.account.id).replace(/"/g, "'")})`;
  A = await openTab();

  // 1. Search box on the list page; the supplier number whose series has the most versions.
  const target = db((c) =>
    c
      .prepare(
        `SELECT q.value_raw, v.version_number, (SELECT max(version_number) FROM quote_versions WHERE series_id = v.series_id) AS latest
           FROM quote_version_supplier_refs q JOIN quote_versions v ON v.id = q.version_id JOIN quote_series s ON s.id = v.series_id
          WHERE q.value_raw IS NOT NULL AND s.request_id IN ${OWNED} ORDER BY latest DESC LIMIT 1`,
      )
      .get(),
  );
  await A.goto(`${BASE}/procurements`, "Search requests and quotes");
  await A.typeInto("#q", target.value_raw);
  await A.shot("25-01-search-typed");
  await A.click(button("Search"));
  // The GET form navigates to ?q=…; wait until that page is complete and its results are rendered.
  await A.waitFor(`location.search.startsWith("?q=") && document.readyState === "complete" && !!document.querySelector('[data-testid="search-results"] [data-field]')`);
  await sleep(1500); // dev mode may re-render once after the first compile
  await A.waitFor(`!!document.querySelector('[data-testid="search-results"] [data-field]')`);
  check("search runs from the list page; typed text stays in the box", (await A.evaluate(`document.querySelector("#q").value`)) === target.value_raw);
  const numberHits = await A.evaluate(`document.querySelectorAll('[data-field="SUPPLIER_QUOTE_NUMBER"]').length`);
  const refCount = db((c) => c.prepare(`SELECT count(*) AS n FROM quote_version_supplier_refs q JOIN quote_versions v ON v.id = q.version_id JOIN quote_series s ON s.id = v.series_id WHERE q.value_raw = ? AND s.request_id IN ${OWNED}`).get(target.value_raw).n);
  const refAll = db((c) => c.prepare("SELECT count(*) AS n FROM quote_version_supplier_refs WHERE value_raw = ?").get(target.value_raw).n);
  check("every supplier-number row of this buyer's records is listed (none merged)", numberHits === refCount, `${numberHits} rows, ${refCount} stored for this buyer`);
  check("rows of records this buyer does not own are not listed", refAll === refCount || numberHits < refAll, `${refAll} stored in total`);
  check("an earlier version is labelled as such", await A.evaluate(bodyHas(`v${target.version_number} — earlier version (latest is v${target.latest})`)));
  check("AI candidates labelled 'not confirmed'", await A.evaluate(bodyHas("AI suggestion — not confirmed")));
  check(
    "quote-name match is labelled separately from supplier numbers",
    await A.evaluate(`[...document.querySelectorAll('[data-field="QUOTE_NAME"]')].every((li) => li.textContent.includes("Quote name"))`),
  );
  await A.shot("25-02-search-results");
  await A.evaluate(`document.querySelector('[data-field="SUPPLIER_QUOTE_NUMBER"]').scrollIntoView({ block: "start" })`);
  await A.shot("25-02b-search-supplier-numbers");

  // 2. Invalid input (control character via URL) and wildcard characters.
  await A.goto(`${BASE}/procurements?q=${encodeURIComponent("QT\nDROP")}`, "Not searched");
  check("control character → 'Not searched' message, nothing searched", await A.evaluate(`!!document.querySelector('[data-testid="search-invalid"]')`));
  await A.goto(`${BASE}/procurements?q=${encodeURIComponent("%")}`, "Search requests and quotes");
  check(
    "'%' is an ordinary character (no match-all)",
    await A.evaluate(`document.body.innerText.includes("No match for") || [...document.querySelectorAll('[data-field]')].every((li) => li.textContent.includes("%"))`),
  );
  await A.shot("25-03-search-percent");

  // 2b. Layout (owner feedback 25 Oct): while searching, only the results area — never the unfiltered list.
  const outsideResults = `[...document.querySelectorAll(".request-list")].filter((ul) => !ul.closest('[data-testid="search-results"]')).length`;
  await A.goto(`${BASE}/procurements?q=${encodeURIComponent("zzz-no-such-thing")}`, "Search results");
  check("no match → empty state only, no unfiltered request list", (await A.evaluate(`!!document.querySelector('[data-testid="search-empty"]')`)) && (await A.evaluate(outsideResults)) === 0);
  await A.goto(`${BASE}/procurements?q=${encodeURIComponent(target.value_raw)}&field=SUPPLIER_QUOTE_NUMBER&sort=OLDEST`, "Search results");
  check(
    "category filter: only Supplier quote number rows; count heading names the unit",
    (await A.evaluate(`[...document.querySelectorAll('[data-testid="search-results"] [data-field]')].every((li) => li.dataset.field === "SUPPLIER_QUOTE_NUMBER")`)) &&
      (await A.evaluate(`/match(es)? across \\d+ procurement request/.test(document.querySelector('[data-testid="search-count"]').textContent)`)) &&
      (await A.evaluate(outsideResults)) === 0,
  );
  check(
    "oldest first: dates ascending",
    await A.evaluate(`(() => { const d = [...document.querySelectorAll('[data-testid="search-results"] [data-date]')].map((li) => li.dataset.date); return d.every((x, i) => i === 0 || d[i - 1] <= x); })()`),
  );
  await A.shot("25-03b-search-filtered");
  await A.click(`document.querySelector('[data-testid="clear-search"]')`);
  await A.waitFor(`location.search === "" && document.readyState === "complete" && !document.querySelector('[data-testid="search-results"]')`);
  check("Clear search restores the normal request list", (await A.evaluate(outsideResults)) === 1);

  // 3. Extraction panel: an older result keeps its actual scope; budget shown; new wording. Older-rules runs exist only
  //    on old, unowned records → not reachable for a signed-in buyer; then the buyer's own successful run is used.
  const legacy = db((c) =>
    c
      .prepare(
        `SELECT r.id, r.started_at, r.request_id, r.series_id, r.version_id FROM quote_extraction_runs r
          WHERE r.status = 'SUCCEEDED' AND json_extract(r.result_json, '$.checkRules') IS NULL AND r.request_id IN ${OWNED} ORDER BY r.started_at LIMIT 1`,
      )
      .get(),
  );
  const run =
    legacy ??
    db((c) => c.prepare(`SELECT r.id, r.request_id, r.series_id, r.version_id FROM quote_extraction_runs r WHERE r.status = 'SUCCEEDED' AND r.mode = 'MOCK' AND r.request_id IN ${OWNED} ORDER BY r.started_at LIMIT 1`).get());
  if (!legacy) console.log("NOT REACHABLE  older-rules result: only on old records without an owner (history-bound; unit tests only)");
  const ledgerBefore = db((c) => c.prepare("SELECT count(*) AS n FROM ai_budget_ledger").get().n);
  await A.goto(`${BASE}/procurements/${run.request_id}/quotes?series=${run.series_id}&version=${run.version_id}`, "AI extraction");
  await A.waitFor(`!!document.querySelector('[data-testid="api-budget"]')`);
  // Open that older run from the run history (a newer run, if any, is shown by default).
  await A.click(`document.querySelector('[data-run-button="${run.id}"]')`);
  await A.waitFor(`!!document.querySelector('[data-run-id="${run.id}"]')`);
  if (legacy) check("older result: 'earlier rules … not re-checked' banner", await A.evaluate(`!!document.querySelector('[data-testid="legacy-rules"]')`));
  check(
    "excerpt status reads 'Source excerpt found — review required' (not 'Supported by the text')",
    (await A.evaluate(bodyHas("Source excerpt found — review required"))) && !(await A.evaluate(bodyHas("Supported by the text"))),
  );
  if (legacy) check("value check shown separately; old facts say earlier rules", await A.evaluate(`!!document.querySelector('[data-value-check="LEGACY"]')`));
  else check("value check shown separately (current rules)", await A.evaluate(`!!document.querySelector('[data-value-check]') && !document.querySelector('[data-value-check="LEGACY"]')`));
  check("review state shown separately", await A.evaluate(`${bodyHas("Pending your review")} || ${bodyHas("Confirmed by you")}`));
  check("budget block shown", await A.evaluate(bodyHas("API budget (real model calls through this app)")));
  await A.evaluate(`document.querySelector('[data-testid="extraction-panel"]').scrollIntoView({ block: "start" })`);
  await A.shot("25-04-extraction-legacy");
  await A.evaluate(`document.querySelector('[data-value-check]').scrollIntoView({ block: "center" })`);
  await A.shot("25-04b-extraction-legacy-facts");

  if (MOCK) {
    // 4. A new MOCK run on the same SYNTHETIC version uses the current rules and writes no budget row.
    await A.click(button("Run again (new model call)"));
    await A.waitFor(`!!document.querySelector('[data-testid="extraction-notice"]')`, 30000);
    await A.waitFor(`!document.querySelector('[data-testid="legacy-rules"]')`, 15000);
    check("new run: no legacy banner; value checks name the current rules", await A.evaluate(bodyHas("rules value-check-2026-10-25.1")));
    check("MOCK runs never use the API budget", await A.evaluate(bodyHas("MOCK runs never use the API budget")));
    const ledgerAfter = db((c) => c.prepare("SELECT count(*) AS n FROM ai_budget_ledger").get().n);
    check("ledger unchanged by MOCK", ledgerAfter === ledgerBefore, `${ledgerBefore} → ${ledgerAfter}`);
    await A.evaluate(`document.querySelector('[data-testid="api-budget"]').scrollIntoView({ block: "start" })`);
    await A.shot("25-05-extraction-current-rules");
    await A.evaluate(`document.querySelector('[data-value-check="MATCH"]').scrollIntoView({ block: "center" })`);
    await A.shot("25-05b-extraction-current-facts");
  } else {
    check("budget not configured → refusal text shown", await A.evaluate(bodyHas("Not configured — real model calls are refused.")));
  }
  check("no page errors", A.errors.length === 0, A.errors.join(" | "));
} catch (err) {
  check("script completed", false, err.message);
  if (A) await A.shot("25-zz-failure").catch(() => {});
} finally {
  A?.close();
  edge.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}
