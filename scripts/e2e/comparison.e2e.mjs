// Browser check for the comparator (26 Oct; manual run, not part of `npm test`). NORMAL (headed) Edge,
// 1366x768; HEADLESS=1 for headless. No model API and no PayPal call in either mode.
//
// Signed in (31 Oct): runs ONLY on a database COPY (E2E_DB; the dev server uses TRADEPROOF_DB_PATH=<same copy>), as a
// throwaway e2e buyer signed in through the real login (scripts/e2e/lib/e2e-auth.mjs); writes carry the CSRF header.
//
//   $env:AI_PROVIDER="mock"; npm run dev   → $env:E2E_DB="<copy>"; node scripts/e2e/comparison.e2e.mjs --setup
//       Creates two clearly labelled [TEST] comparator requests with the SYNTHETIC zh demo quote and ONE
//       labelled MOCK run each (canned output, never a model, never the API budget). On the "browser check"
//       record it then saves reviews (a correction, a pairing choice) and an edit + reorder of the request,
//       checking the comparison page after each step. The "manual acceptance" record is left unreviewed for
//       the owner. Ids are kept in <copy>.e2e-comparison-state.json (next to the copy).
//   (restart the dev server)               → node scripts/e2e/comparison.e2e.mjs
//       Read-only, as the same buyer: the browser-check record after the restart (correction, pairing, update
//       notice), the manual-acceptance record unreviewed; a LIVE acceptance record (LA-1) is 404 for this buyer.
//       The 26 Oct read-only checks of LA-1…LA-5, the older-rules run and other old records are history-bound:
//       those records have no owner since access control (owner's decision), so no signed-in user can open them;
//       the comparator logic behind them stays covered by tests/comparison*.test.ts.
// Screenshots in data/e2e-screens/ (Git-ignored).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // signed-in e2e buyer (real login)
const STATE = `${DB}.e2e-comparison-state.json`; // next to the copy, outside the repository
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const SETUP = process.argv.includes("--setup");
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
const counts = () =>
  db((c) => {
    const n = (sql) => Number(c.prepare(sql).get().n);
    return {
      ledger: n("SELECT count(*) AS n FROM ai_budget_ledger"),
      settled: n("SELECT coalesce(sum(settled_micros), 0) AS n FROM ai_budget_ledger"),
      live: n("SELECT count(*) AS n FROM quote_extraction_runs WHERE mode = 'LIVE'"),
      mock: n("SELECT count(*) AS n FROM quote_extraction_runs WHERE mode = 'MOCK'"),
      reviews: n("SELECT count(*) AS n FROM quote_extraction_reviews"),
      payments: n("SELECT count(*) AS n FROM sandbox_payment_records"),
    };
  });
mkdirSync(SHOTS, { recursive: true });

async function openTab() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let seq = 0;
  const waiting = new Map();
  const tab = { posts: [], errors: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent" && msg.params.request.method !== "GET") tab.posts.push(`${msg.params.request.method} ${msg.params.request.url}`);
    if (msg.method === "Runtime.exceptionThrown") tab.errors.push(msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") tab.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
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

const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const api = async (method, path, body) => {
  const res = await authedFetch(BASE, SESSION, path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const read = (f) => readFileSync(join("samples", "synthetic", f), "utf8").replace(/\r\n/g, "\n");
const compareUrl = (s, run, baseRun) => `${BASE}/procurements/${s.requestId}/quotes/compare?series=${s.seriesId}&version=${s.versionId}${run ? `&run=${run}` : ""}${baseRun ? `&baseRun=${baseRun}` : ""}`;
const rowSel = (field, item) => `[data-testid="compare-details"] tr[data-field="${field}"]${item ? `[data-request-item="${item}"]` : ""}`;
const outcomeOf = (field, item) => `(${sel(rowSel(field, item))})?.dataset.outcome ?? null`;

/** A [TEST] request + the SYNTHETIC zh demo quote + one labelled MOCK run (canned output; no model, no budget). */
async function createTestRecord(label) {
  const item = (name, quantity, material, customization) => ({ id: null, name, quantity, unit: "pcs", material, specification: "", customization, notes: "" });
  const created = await api("POST", "/api/procurements", {
    title: `[TEST] comparator — ${label} (26 Oct, SYNTHETIC)`,
    buyerType: "BUSINESS",
    buyerCompany: "TradeProof test (fictional)",
    buyerPersonName: "",
    supplierName: "宁波示例日用品有限公司（虚构）",
    shipFrom: "FOB Ningbo",
    shipTo: "Singapore",
    budgetCurrency: "CNY",
    budgetMax: "12000.00",
    requiredShipDate: "2026-12-20",
    expectedDeliveryDate: "",
    paymentTerms: "30% deposit, 70% before shipment",
    additionalRequirements: "",
    items: [item("Stainless steel vacuum bottle 不锈钢保温杯 500 ml", "500", "304 stainless steel", "Laser engraved logo, 1 colour"), item("Gift box", "500", "", "")],
    source: "USER_INPUT",
  });
  if (created.status !== 201) throw new Error(`create request: ${created.status} ${JSON.stringify(created.data)}`);
  const record = created.data.record;
  const saved = await api("POST", `/api/procurements/${record.id}/quotes`, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: record.revision,
    name: `[TEST] comparator — SYNTHETIC zh demo quote (${label})`,
    rawText: read("supplier-quote-zh.synthetic.md"),
    source: "TEST_FIXTURE",
    sourceNote: "samples/synthetic/supplier-quote-zh.synthetic.md (comparator e2e, 26 Oct)",
  });
  if (saved.status !== 201) throw new Error(`save quote: ${saved.status} ${JSON.stringify(saved.data)}`);
  const s = { requestId: record.id, seriesId: saved.data.series.id, versionId: saved.data.version.id, lines: record.items.map((i) => i.id) };
  const extractions = `/api/procurements/${s.requestId}/quotes/${s.seriesId}/versions/${s.versionId}/extractions`;
  const listed = await api("GET", extractions);
  if (listed.data.config?.state !== "READY" || listed.data.config.mode !== "MOCK") throw new Error(`server is not in MOCK mode (${JSON.stringify(listed.data.config)}) — refusing to run`);
  const run = await api("POST", extractions, { idempotencyKey: randomUUID() });
  if (run.status !== 201 || run.data.run.mode !== "MOCK") throw new Error(`MOCK run: ${run.status} ${JSON.stringify(run.data).slice(0, 300)}`);
  return { ...s, runId: run.data.run.id };
}

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-compare-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
const edge = spawn(EDGE, args, { stdio: "ignore" });
let A;
const before = counts();
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  // Same buyer across setup and the read-only run (owner of the [TEST] records); a fresh one if none is kept yet.
  SESSION = await e2eSession(DB, BASE, PORT, { reuse: true });
  A = await openTab();

  if (SETUP) {
    // ---------------------------------------------------------------- setup (MOCK server)
    // Records from an earlier (interrupted) setup are reused, never duplicated.
    const prior = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
    const check1 = prior?.browserCheck ?? (await createTestRecord("browser check"));
    const manual = prior?.manualAcceptance ?? (await createTestRecord("manual acceptance"));
    if (!prior) writeFileSync(STATE, JSON.stringify({ createdAt: new Date().toISOString(), browserCheck: check1, manualAcceptance: manual }, null, 2));
    const afterSetup = counts();
    check(`setup: ${prior ? "existing records reused, no run added" : "2 MOCK runs added"}, no LIVE run, ledger unchanged`, afterSetup.mock === before.mock + (prior ? 0 : 2) && afterSetup.live === before.live && afterSetup.ledger === before.ledger && afterSetup.settled === before.settled, JSON.stringify(afterSetup));

    const [L1, L2] = check1.lines;
    // Entry from the quote version.
    await A.goto(`${BASE}/procurements/${check1.requestId}/quotes?series=${check1.seriesId}&version=${check1.versionId}`, "Compare with request");
    await A.waitFor(`!!${sel('[data-testid="compare-run-link"] a')}`);
    check("quote page: entry link and per-run link present", await A.evaluate(`!!${sel('[data-testid="compare-entry"] a')} && !!${sel('[data-testid="compare-run-link"] a')}`));
    const postsBefore = A.posts.length;
    await A.click(sel('[data-testid="compare-entry"] a'));
    await A.waitFor(`location.pathname.endsWith("/compare") && location.search.includes("run=") && !!${sel('[data-testid="compare-summary"]')}`);
    check("entry opens the comparison and names the run in the address (refresh-stable)", await A.evaluate(`new URLSearchParams(location.search).get("run") === ${JSON.stringify(check1.runId)}`));
    check("basis: request revision 1, version, run (MOCK labelled)", await A.evaluate(`${sel('[data-testid="basis-request"]')}.innerText.includes("revision 1") && ${sel('[data-testid="basis-run"]')}.dataset.runId === ${JSON.stringify(check1.runId)} && !!${sel('[data-testid="mock-run"]')}`));
    check("quantity 480 vs 500 → Difference; pairing proposed (not confirmed)", (await A.evaluate(outcomeOf("quantity", L1))) === "DIFFERENCE" && (await A.evaluate(bodyHas("Pairing proposed by the model — not confirmed"))));
    check("material 201 vs 304 and logo screen print vs laser → Difference", (await A.evaluate(outcomeOf("material", L1))) === "DIFFERENCE" && (await A.evaluate(outcomeOf("logo", L1))) === "DIFFERENCE");
    check("payment terms 50/50 vs 30/70 → Difference; Incoterm FOB → Consistent", (await A.evaluate(outcomeOf("paymentTerms"))) === "DIFFERENCE" && (await A.evaluate(outcomeOf("incoterm"))) === "MATCH");
    check("gift box line not quoted → Needs clarification", (await A.evaluate(`${sel(rowSel("pairing", L2))}?.dataset.note`)) === "NOT_QUOTED");
    check("fees: packaging TBC and per-unit laser fee open; no total cost", (await A.evaluate(`[...document.querySelectorAll('[data-testid="compare-fees"] tr[data-fee-status]')].map((r) => r.dataset.feeStatus).join()`)) === "OPEN,OPEN" && (await A.evaluate(bodyHas("Not a total cost"))));
    check("consistent rows say 'review required', not confirmed", await A.evaluate(`[...document.querySelectorAll('tr[data-outcome="MATCH"] .compare-value')].every((v) => v.dataset.review === "PENDING" && v.innerText.includes("review required"))`));
    await A.shot("26-01-compare-mock-initial");
    // Evidence can be opened.
    await A.click(`${sel(rowSel("quantity", L1))}.querySelector("details summary")`);
    check("evidence expands with the excerpt and the whole line", await A.evaluate(`${sel(rowSel("quantity", L1))}.querySelector("details").open && ${sel(rowSel("quantity", L1))}.innerText.includes("Whole line in the stored text")`));
    await A.shot("26-02-compare-evidence");

    // Correction + pairing choice (saved through the normal review API, as the panel does).
    const reviews = `/api/procurements/${check1.requestId}/quotes/${check1.seriesId}/versions/${check1.versionId}/extractions/${check1.runId}/reviews`;
    const c1 = await api("POST", reviews, { idempotencyKey: randomUUID(), fieldPath: "items[0].quantity", action: "CORRECT", valueText: "500", basedOnReviewId: null });
    const c2 = await api("POST", reviews, { idempotencyKey: randomUUID(), fieldPath: "items[0].match", action: "MATCH_ITEM", requestItemId: L1, basedOnReviewId: null });
    check("two reviews saved on the test run", c1.status === 201 && c2.status === 201);
    await A.goto(compareUrl(check1, check1.runId), "Comparison basis");
    check("after correction: quantity Consistent, shown as your statement, model value 480 kept", (await A.evaluate(outcomeOf("quantity", L1))) === "MATCH" && (await A.evaluate(`${sel(rowSel("quantity", L1))}.innerText.includes("Your statement (corrected)") && ${sel(rowSel("quantity", L1))}.innerText.includes("Model said: 480")`)));
    check("pairing now chosen by you", await A.evaluate(`${sel('[data-testid="compare-pairing"] tr[data-quote-index="0"]')}.dataset.pairing === "CONFIRMED"`));
    await A.shot("26-03-compare-after-review");

    // Edit + reorder the request → revision 2; the comparison keeps revision 1 and says so.
    const current = (await api("GET", `/api/procurements/${check1.requestId}`)).data.record;
    const items = current.items.map((i) => ({ id: i.id, name: i.name, quantity: String(i.quantity ?? ""), unit: i.unit ?? "", material: i.material ?? "", specification: i.specification ?? "", customization: i.customization ?? "", notes: i.notes ?? "" })).reverse();
    items.find((i) => i.id === L1).quantity = "600";
    const upd = await api("PUT", `/api/procurements/${check1.requestId}`, {
      revision: current.revision,
      title: current.title,
      buyerType: current.buyerType ?? "",
      buyerCompany: current.buyerCompany ?? "",
      buyerPersonName: current.buyerPersonName ?? "",
      supplierName: current.supplierName ?? "",
      shipFrom: current.shipFrom ?? "",
      shipTo: current.shipTo ?? "",
      budgetCurrency: current.budgetCurrency ?? "",
      budgetMax: current.budgetMax ?? "",
      requiredShipDate: current.requiredShipDate ?? "",
      expectedDeliveryDate: current.expectedDeliveryDate ?? "",
      paymentTerms: current.paymentTerms ?? "",
      additionalRequirements: current.additionalRequirements ?? "",
      items,
    });
    check("request edited and lines reordered → revision 2", upd.status === 200 && upd.data.record.revision === 2, `${upd.status}`);
    await A.goto(compareUrl(check1, check1.runId), "Comparison basis");
    check("request-updated notice; basis still revision 1", await A.evaluate(`!!${sel('[data-testid="request-updated"]')} && ${sel('[data-testid="basis-request"]')}.innerText.includes("revision 1")`));
    check("after reorder + edit: same pairing, request text still 500 pcs from the snapshot", (await A.evaluate(outcomeOf("quantity", L1))) === "MATCH" && (await A.evaluate(`${sel(rowSel("quantity", L1))}.innerText.includes("500 pcs")`)));
    await A.shot("26-04-compare-request-updated");
    check("no POST from the comparison pages themselves", A.posts.slice(postsBefore).length === 0, A.posts.slice(postsBefore).join(" | "));
  } else {
    // ---------------------------------------------------------------- read-only (normal server)
    const live = db((c) =>
      c
        .prepare("SELECT r.id, r.request_id, r.series_id, r.version_id, p.title FROM quote_extraction_runs r JOIN procurement_requests p ON p.id = r.request_id WHERE r.mode = 'LIVE' ORDER BY r.started_at")
        .all(),
    );
    const s = (r) => ({ requestId: r.request_id, seriesId: r.series_id, versionId: r.version_id });

    // LA-1 (LIVE, 25 Oct) has no owner since access control → 404 for this buyer, like any id it may not read.
    const la1 = live.find((r) => r.title.includes("LA-1"));
    if (la1) {
      await A.send("Page.navigate", { url: compareUrl(s(la1), la1.id) });
      await A.waitFor(`document.readyState === "complete"`);
      await sleep(300);
      check("LA-1 (old, unowned) comparison → 404 for this buyer", await A.evaluate(`document.title.includes("404") || document.body.innerText.includes("could not be found")`));
    }

    if (existsSync(STATE)) {
      const st = JSON.parse(readFileSync(STATE, "utf8"));
      await A.goto(compareUrl(st.browserCheck, st.browserCheck.runId), "Comparison basis");
      check("browser-check record after restart: correction and pairing still applied, update notice shown", await A.evaluate(`${sel(rowSel("quantity", st.browserCheck.lines[0]))}.dataset.outcome === "MATCH" && !!${sel('[data-testid="request-updated"]')} && ${sel('[data-testid="compare-pairing"] tr[data-quote-index="0"]')}.dataset.pairing === "CONFIRMED"`));
      await A.goto(compareUrl(st.manualAcceptance, st.manualAcceptance.runId), "Comparison basis");
      check("manual-acceptance record: unreviewed (all pending)", await A.evaluate(`[...document.querySelectorAll(".compare-value")].every((v) => v.dataset.review === "PENDING")`));
    } else check("setup state next to the copy", false, `${STATE} not found — run --setup first`);
    check("no non-GET request sent by any page", A.posts.length === 0, A.posts.join(" | "));
  }
  check("no console errors", A.errors.length === 0, A.errors.join(" | ").slice(0, 300));
  const after = counts();
  if (SETUP) check("ledger and LIVE runs unchanged; payments unchanged", after.ledger === before.ledger && after.settled === before.settled && after.live === before.live && after.payments === before.payments, JSON.stringify(after));
  else check("read-only: ledger, runs, reviews, payments all unchanged", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  A?.close();
  edge.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Edge may still hold the profile briefly
  }
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
