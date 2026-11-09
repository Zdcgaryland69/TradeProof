// Browser check for the bilingual clarification draft (27 Oct; manual run, not part of `npm test`). NORMAL
// (headed) Edge, 1366x768; HEADLESS=1 for headless. Needs `npm run dev` with the normal .env.local (LIVE
// mode is fine: nothing here can start an extraction). No model, translation service or PayPal call.
//
// Signed in (31 Oct): runs ONLY on a database COPY (E2E_DB; the dev server uses TRADEPROOF_DB_PATH=<same copy>), as the
// e2e buyer that the comparison setup signed in (session kept next to the copy; real login, CSRF header on writes).
//
//   $env:E2E_DB="<copy>"; node scripts/e2e/clarification.e2e.mjs      (after comparison.e2e.mjs --setup on that copy)
//       On the [TEST] "browser check" comparator record from <copy>.e2e-comparison-state.json (MOCK run):
//       creates ONE draft from the comparison page (a second press opens the same draft), checks the paired
//       questions and the check, edits one Chinese amount (check goes out of date → re-run → inconsistency
//       located), saves (revision 2), saves again unchanged (nothing written), reloads, opens the copy warning.
//       The draft id is kept in <copy>.e2e-clarification-state.json.
//   node scripts/e2e/clarification.e2e.mjs --verify
//       Read-only, after a dev-server restart: the draft, its revision and its edit are still there.
// Screenshots in data/e2e-screens/ (Git-ignored).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { e2eDb, e2eSession } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
const SOURCE = `${DB}.e2e-comparison-state.json`; // written by comparison.e2e.mjs --setup on the same copy
const STATE = `${DB}.e2e-clarification-state.json`;
const SHOTS = join(process.cwd(), "data", "e2e-screens");
const VERIFY = process.argv.includes("--verify");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const counts = () => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    const n = (sql) => Number(c.prepare(sql).get().n);
    return {
      ledger: n("SELECT count(*) AS n FROM ai_budget_ledger"),
      settled: n("SELECT coalesce(sum(settled_micros), 0) AS n FROM ai_budget_ledger"),
      live: n("SELECT count(*) AS n FROM quote_extraction_runs WHERE mode = 'LIVE'"),
      mock: n("SELECT count(*) AS n FROM quote_extraction_runs WHERE mode = 'MOCK'"),
      reviews: n("SELECT count(*) AS n FROM quote_extraction_reviews"),
      versions: n("SELECT count(*) AS n FROM quote_versions"),
      requests: n("SELECT count(*) AS n FROM procurement_requests"),
      payments: n("SELECT count(*) AS n FROM sandbox_payment_records"),
      paymentEvents: n("SELECT count(*) AS n FROM sandbox_payment_events"),
      drafts: n("SELECT count(*) AS n FROM clarification_drafts"),
      revisions: n("SELECT count(*) AS n FROM clarification_draft_revisions"),
    };
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
  const tab = { requests: [], errors: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      const r = msg.params.request;
      // data: / blob: URLs (inline icons) are not network requests.
      if (!/^(data|blob):/.test(r.url) && (r.method !== "GET" || !r.url.startsWith(BASE))) tab.requests.push(`${r.method} ${r.url}`);
    }
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
    /** Types into a React-controlled textarea the way a user's edit arrives (native setter + input event). */
    async setText(expression, value) {
      await evaluate(
        `(() => { const e = ${expression}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
      );
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
  // window.confirm is answered "OK" (the only confirms here are the copy / regenerate / reset prompts we test).
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.confirm = () => true;" });
  return tab;
}

const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
// The draft editor's question cards (the reply tracker added on 28 Oct also carries data-question, without a template).
const QCARD = "[data-question][data-template]";
const q = (template) => `document.querySelector('[data-template="${template}"]')`;

if (!existsSync(SOURCE)) {
  console.log(`FAIL  ${SOURCE} not found — run comparison.e2e.mjs --setup on this copy first.`);
  process.exit(1);
}
const rec = JSON.parse(readFileSync(SOURCE, "utf8")).browserCheck;
const compareUrl = `${BASE}/procurements/${rec.requestId}/quotes/compare?series=${rec.seriesId}&version=${rec.versionId}&run=${rec.runId}`;
const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-clarification-"));
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
  await e2eSession(DB, BASE, PORT, { reuse: true }); // the buyer that owns the comparator record
  A = await openTab();

  if (!VERIFY) {
    await A.goto(compareUrl, "Clarification draft (English / 简体中文)");
    check("comparison page: draft entry with the template / nothing-sent note", await A.evaluate(`!!${sel('[data-testid="create-draft"]')} && document.body.innerText.includes("Nothing is sent")`));
    await A.click(sel('[data-testid="create-draft"]'));
    await A.waitFor(`location.pathname.includes("/quotes/drafts/cd_") && document.body.innerText.includes("Template-generated draft")`);
    const draftUrl = await A.evaluate("location.href");
    const draftId = draftUrl.split("/").pop();
    writeFileSync(STATE, JSON.stringify({ createdAt: new Date().toISOString(), record: rec, draftId, draftUrl }, null, 2));
    const afterCreate = counts();
    check("one draft and one revision written", afterCreate.drafts === before.drafts + 1 && afterCreate.revisions === before.revisions + 1, JSON.stringify(afterCreate));
    check(
      "banner: template-generated, review before sending, not AI, nothing sent",
      await A.evaluate(`(() => { const t = ${sel('[data-testid="draft-banner"]')}.innerText; return t.includes("Template-generated draft · Review before sending") && t.includes("模板生成的草稿") && t.includes("not an AI result") && t.includes("TradeProof sends nothing"); })()`),
    );
    const templates = await A.evaluate(`[...document.querySelectorAll(${JSON.stringify(QCARD)})].map((e) => e.dataset.template + ":" + e.dataset.selected)`);
    check(
      "7 questions from the comparison, all selected",
      JSON.stringify(templates) === JSON.stringify(["MATERIAL_DIFFERS:yes", "LOGO_DIFFERS:yes", "TOTAL_DIFFERS:yes", "PAYMENT_DIFFERS:yes", "NOT_QUOTED:yes", "FEE_OPEN:yes", "FEE_OPEN:yes"]),
      JSON.stringify(templates),
    );
    check("side by side: English and 简体中文 text per question", await A.evaluate(`[...document.querySelectorAll(${JSON.stringify(QCARD)})].every((e) => e.querySelector('[data-lang="en"] textarea') && e.querySelector('[data-lang="zh"] textarea'))`));
    check(
      "material question: request 304 vs quote 201 as read, asks about price effect",
      await A.evaluate(`${q("MATERIAL_DIFFERS")}.querySelector('[data-lang="en"] textarea').value.includes("our request specifies “304 stainless steel”. As we read your quote, it states “201 不锈钢”. Can you supply")`),
    );
    check(
      "check on load: nothing found by the rules, with the not-a-sign-off note; no 'verified'",
      await A.evaluate(`${sel('[data-testid="draft-check"]')}.dataset.overall === "NONE_FOUND" && document.body.innerText.includes("not a sign-off") && !/verified translation|translation verified/i.test(document.body.innerText)`),
    );
    await A.shot("27-01-draft-created");

    // Refresh and a second press on the comparison page: no second draft.
    await A.goto(draftUrl, "Template-generated draft");
    await A.goto(compareUrl, "Clarification draft (English / 简体中文)");
    check("comparison page lists the draft", await A.evaluate(`!!document.querySelector('[data-draft="${draftId}"]')`));
    await A.click(sel('[data-testid="create-draft"]'));
    await A.waitFor(`location.pathname.endsWith(${JSON.stringify(draftId)})`);
    check("refresh + second create press: same draft, nothing written", JSON.stringify(counts()) === JSON.stringify(afterCreate), JSON.stringify(counts()));

    // Views.
    await A.click(sel('[data-view="en"]'));
    check("English view: only English texts", await A.evaluate(`document.querySelectorAll('[data-lang="zh"]').length === 0 && document.querySelectorAll('[data-lang="en"]').length > 0`));
    await A.click(sel('[data-view="zh"]'));
    check("简体中文 view: only Chinese texts", await A.evaluate(`document.querySelectorAll('[data-lang="en"]').length === 0 && document.querySelectorAll('[data-lang="zh"]').length > 0`));
    await A.click(sel('[data-view="side"]'));

    // Edit one Chinese amount: the old result goes out of date until the check is run again.
    const zh = `${q("TOTAL_DIFFERS")}.querySelector('[data-lang="zh"] textarea')`;
    const original = await A.evaluate(`${zh}.value`);
    await A.setText(zh, original.replace("CNY 11,760.00", "CNY 11,670.00"));
    await A.waitFor(`!!${sel('[data-testid="check-stale"]')}`);
    check("after an edit: check marked out of date, old result hidden, unsaved shown", await A.evaluate(`!${sel('[data-testid="check-result"]')} && document.body.innerText.includes("Unsaved changes")`));
    await A.click(sel('[data-testid="run-check"]'));
    await A.waitFor(`${sel('[data-testid="draft-check"]')}.dataset.overall === "INCONSISTENT"`);
    check(
      "re-run: inconsistency located in that question, in Chinese, with both values",
      await A.evaluate(
        `${q("TOTAL_DIFFERS")}.dataset.check === "INCONSISTENT" && ${q("TOTAL_DIFFERS")}.querySelector('[data-lang="zh"] [data-finding="CHANGED"]').innerText.includes("CNY 11,760.00") && ${q("TOTAL_DIFFERS")}.querySelector('[data-lang="zh"] [data-finding="CHANGED"]').innerText.includes("11,670.00")`,
      ),
    );
    await A.shot("27-02-inconsistency-located");

    // Copy with pending items: a warning first; cancel copies nothing.
    await A.click(sel('[data-testid="copy-zh"]'));
    await A.waitFor(`!!${sel('[data-testid="copy-warning"]')}`);
    check("copy warning lists the inconsistency and unsaved text; copying settles nothing", await A.evaluate(`(() => { const t = ${sel('[data-testid="copy-warning"]')}.innerText; return t.includes("inconsistencies") && t.includes("unsaved") && t.includes("does not send, approve or confirm"); })()`));
    await A.shot("27-03-copy-warning");
    await A.click(`[...document.querySelectorAll('[data-testid="copy-warning"] button')].find((b) => b.innerText === "Cancel")`);

    // Save → revision 2; unchanged save → nothing written.
    await A.click(sel('[data-testid="save-draft"]'));
    await A.waitFor(`${sel('[data-testid="draft-notice"]')}?.innerText.includes("Clarification draft saved — revision 2")`);
    await A.click(sel('[data-testid="save-draft"]'));
    await A.waitFor(`${sel('[data-testid="draft-notice"]')}?.innerText.includes("Clarification draft: no changes to save")`);
    const afterSave = counts();
    check("save wrote one revision; the unchanged save wrote nothing", afterSave.revisions === afterCreate.revisions + 1 && afterSave.drafts === afterCreate.drafts, JSON.stringify(afterSave));

    // Reload: the edit and the check result are there; the generated text is kept apart ("edited").
    await A.goto(draftUrl, "Template-generated draft");
    check(
      "after reload: edited text kept and labelled edited; check shows the inconsistency",
      await A.evaluate(`${zh}.value.includes("CNY 11,670.00") && ${q("TOTAL_DIFFERS")}.querySelector('[data-lang="zh"] .pill.warn')?.innerText === "edited" && ${sel('[data-testid="draft-check"]')}.dataset.overall === "INCONSISTENT"`),
    );
    check("save state after reload: all saved, revision 2", await A.evaluate(`${sel('[data-testid="draft-save-state"]')}.innerText.includes("All changes saved (revision 2)")`));

    // Copy English anyway (the clipboard may be unavailable without a user gesture → the fallback text box).
    await A.click(sel('[data-testid="copy-en"]'));
    await A.waitFor(`!!${sel('[data-testid="copy-warning"]')}`);
    await A.click(sel('[data-testid="copy-anyway"]'));
    await A.waitFor(`${sel('[data-testid="draft-notice"]')}?.innerText.length > 0`);
    const copied = await A.evaluate(`${sel('[data-testid="draft-notice"]')}.innerText`);
    check("copy: 'copied, nothing was sent' (or the manual-copy box); nothing marked sent", /Nothing was sent|Select the text below/.test(copied) && !/\bsent to\b|marked as sent/i.test(copied), copied);
    check("copy wrote nothing", JSON.stringify(counts()) === JSON.stringify(afterSave));
    await A.shot("27-04-after-copy");

    const nonGet = A.requests.filter((r) => !r.startsWith("GET "));
    check(
      "only the draft create and save requests left the page; no other host contacted",
      nonGet.every((r) => /^POST .*\/clarification-drafts$/.test(r) || /^PUT .*\/clarification-drafts\/cd_/.test(r) || /^POST .*\/_next\//.test(r) || /^POST .*\/procurements\/.*\/quotes\/compare/.test(r)) &&
        A.requests.every((r) => r.includes("127.0.0.1")),
      A.requests.join(" | ").slice(0, 400),
    );
  } else {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    await A.goto(st.draftUrl, "Template-generated draft");
    check(
      "after restart: draft, revision 2, the edit and the located inconsistency are still there",
      await A.evaluate(
        `${q("TOTAL_DIFFERS")}.querySelector('[data-lang="zh"] textarea').value.includes("CNY 11,670.00") && ${sel('[data-testid="draft-save-state"]')}.innerText.includes("revision 2") && ${sel('[data-testid="draft-check"]')}.dataset.overall === "INCONSISTENT"`,
      ),
    );
    check("after restart: source still names the MOCK run", await A.evaluate(`${sel('[data-testid="draft-basis"]')}.innerText.includes("MOCK") && ${sel('[data-testid="draft-basis"]')}.textContent.includes(${JSON.stringify(rec.runId)})`));
    check("read-only: opening sent nothing", A.requests.filter((r) => !r.startsWith("GET ")).length === 0, A.requests.join(" | "));
    await A.shot("27-05-after-restart");
  }
  check("no console errors", A.errors.length === 0, A.errors.join(" | ").slice(0, 300));
  const after = counts();
  const same = (k) => after[k] === before[k];
  check("ledger, runs, reviews, versions, requests and payments unchanged", ["ledger", "settled", "live", "mock", "reviews", "versions", "requests", "payments", "paymentEvents"].every(same), JSON.stringify(after));
  if (VERIFY) check("verify run wrote nothing", JSON.stringify(after) === JSON.stringify(before));
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
