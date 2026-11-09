// Browser check for supplier reply tracking (29 Oct, schema v13; manual run, not part of `npm test`). NORMAL (headed)
// Edge, 1366x768; HEADLESS=1 for headless. Needs `npm run dev` (LIVE mode is fine: nothing here can start a model call).
// No model, translation service or PayPal call.
//
//   node scripts/e2e/replies.e2e.mjs
//       Repeatable: each run first seeds a NEW, clearly marked "[TEST] e2e replies <time> (SYNTHETIC)" record
//       (scripts/e2e/seed-replies.mjs: request, quote v1, one MOCK replay run, one draft) and works only on it.
//       Covers fixed Q numbers + draft scope, copied text with [Qn] and the draft reference, a reply that writes no
//       quote version, the same text saved again as a separate reply (possible duplicate, not merged), an unassigned
//       reply, the three statement classifications and the four separate facts, a contradiction, a basis change
//       after a review of the draft's run, an updated quote linked and shown as unverified, a stale-tab conflict, and
//       that no request leaves for another host (data: / blob: are not network requests; ws / http / https are).
//       Nothing is deleted; earlier records (including the owner's) are not touched. State: data/e2e-replies-state.json.
//   node scripts/e2e/replies.e2e.mjs --verify
//       Read-only, after a dev-server restart: the last run's record still shows everything.
// Screenshots in data/e2e-screens/ (Git-ignored).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { principalOf, e2eDb, e2eSession, signInBrowser } from "./lib/e2e-auth.mjs";
import { seedReplyRecord } from "./seed-replies.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb(); // a database COPY only; the dev server runs on the same copy
let SESSION; // signed-in e2e buyer (real login)
const STATE = join(process.cwd(), "data", "e2e-replies-state.json");
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
      supplierReplies: n("SELECT count(*) AS n FROM supplier_replies"),
      links: n("SELECT count(*) AS n FROM clarification_replies"),
      answers: n("SELECT count(*) AS n FROM clarification_answers"),
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
      if (r.method !== "GET" || !r.url.startsWith(BASE)) tab.requests.push(`${r.method} ${r.url}`);
    }
    if (msg.method === "Network.webSocketCreated") tab.requests.push(`WS ${msg.params.url}`);
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
  // window.confirm is answered "OK" (no confirm is expected in this flow).
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.confirm = () => true;" });
  return tab;
}


const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const card = (n) => `document.querySelectorAll('[data-testid="reply-card"]')[${n - 1}]`;
const states = () => `[...document.querySelectorAll('[data-testid="reply-question"]')].map((e) => e.dataset.state).join()`;
const setInput = (expression, value) =>
  `(() => { const e = ${expression}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
// Right after a navigation React may not have hydrated yet and would reset a typed value: type, then wait until the
// save button is enabled (re-typing if the value was reset).
async function typeReply(tab, text) {
  for (let i = 0; i < 20; i++) {
    await tab.setText(sel('[data-testid="reply-raw"]'), text);
    await sleep(250);
    if (await tab.evaluate(`!${sel('[data-testid="reply-save"]')}.disabled && ${sel('[data-testid="reply-raw"]')}.value.length > 0`)) return;
  }
  throw new Error("reply form did not accept the text");
}

// Changing the DOM before React has hydrated makes a hydration mismatch (seen once: a <details> opened by this
// script before hydration). After every navigation, wait until React has attached to the reply section.
async function hydrated(tab) {
  await tab.waitFor(`(() => { const e = document.querySelector('[data-testid="replies"]'); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`);
}

// Hand-written SYNTHETIC supplier replies.
const REPLY = ["> SYNTHETIC / DEMO — 虚构供应商回复，仅用于 TradeProof 测试。", "", "1. 数量 250 件可以接受。", "2. 材质可改为 316 不锈钢，单价另行报价。", "3. 付款方式：30% 定金，70% 发货前付清，可再商量。"].join("\n");
const UNASSIGNED = "> SYNTHETIC / DEMO — 虚构供应商回复（未分配），仅用于 TradeProof 测试。\n\n样品下周寄出。";
const EXCERPT_MAT = "材质可改为 316 不锈钢，单价另行报价";
const EXCERPT_PAY = "付款方式：30% 定金，70% 发货前付清，可再商量";
const NEW_QUOTE = "> SYNTHETIC / DEMO — 虚构更新报价，仅用于 TradeProof 测试。\n\n材质：316 不锈钢；单价：人民币 27.80 元 / 个。";

// Any request leaving for something other than this app is a failure — except data: / blob: (no network).
const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
const external = (reqs) => reqs.map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !LOCAL.some((l) => u.startsWith(l)));

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-replies-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
let A;
let B;
let edge = null;
const before = counts();
let afterSeed = before;
try {
  if (!VERIFY) {
    // A new, clearly marked [TEST] record for this run (MOCK replay, no model call).
    SESSION = await e2eSession(DB, BASE, null);
    process.env.SEED_DB = DB;
    const owner = await principalOf(DB, SESSION.account.username);
    let rec;
    try {
      rec = await seedReplyRecord("e2e replies", { principal: owner.principal, id: owner.principal.id });
    } finally {
      owner.close();
    }
    afterSeed = counts();
    check(
      "seeded a new [TEST] record: 1 request, 1 quote version, 1 MOCK run, 1 draft; no LIVE run, no budget row",
      afterSeed.requests === before.requests + 1 && afterSeed.versions === before.versions + 1 && afterSeed.mock === before.mock + 1 && afterSeed.live === before.live && afterSeed.ledger === before.ledger && afterSeed.drafts === before.drafts + 1,
      rec.title,
    );
    const qn = (template) => rec.questions.find((q) => q.template === template).n;
    const Q = { qty: qn("QUANTITY_DIFFERS"), mat: qn("MATERIAL_DIFFERS"), pay: qn("PAYMENT_DIFFERS") };
    const rq = (n) => `document.querySelectorAll('[data-testid="reply-question"]')[${n - 1}]`;
    const draftUrl = `${BASE}/procurements/${rec.requestId}/quotes/drafts/${rec.draftId}`;
    const draftRef = `CD-${rec.draftId.replace(/^cd_/, "").slice(0, 8).toUpperCase()}`;
    const api = `${BASE}/api/procurements/${rec.requestId}`;
    writeFileSync(STATE, JSON.stringify({ createdAt: new Date().toISOString(), record: rec, draftUrl, done: false }, null, 2));

    edge = spawn(EDGE, args, { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
      await sleep(200);
    }
    await signInBrowser(PORT, BASE, SESSION);
    A = await openTab();
    await A.goto(draftUrl, "Supplier replies");
    await hydrated(A);
    const n = rec.questions.length;
    const numbers = await A.evaluate(`[...document.querySelectorAll('[data-question] [data-testid="q-number"]')].map((e) => e.innerText)`);
    check(`draft cards carry fixed numbers Q1…Q${n}`, JSON.stringify(numbers) === JSON.stringify(rec.questions.map((q) => `Q${q.n}`)), JSON.stringify(numbers));
    check("Q numbers stated to belong to this draft only", await A.evaluate(`${sel('[data-testid="q-scope"]')}.innerText.includes(${JSON.stringify(draftRef)}) && ${sel('[data-testid="q-scope"]')}.innerText.includes("nothing is matched")`));
    check("fresh record: no replies, every question open, each shows 'Deal: not approved'", await A.evaluate(`${sel('[data-testid="replies"]')}.dataset.replies === "0" && [...document.querySelectorAll('[data-testid="reply-question"]')].every((e) => e.dataset.state === "OPEN" && e.querySelector('[data-fact="approved"]').innerText.includes("not approved"))`));

    // Copy with Q1 left out: list renumbered, Q numbers kept, draft reference at the end.
    await A.evaluate(`(() => { window.__copied = null; if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { window.__copied = t; }; return true; })()`);
    await A.click(`document.querySelectorAll('[data-question]')[0].querySelector('[data-testid="include"]')`);
    await A.click(sel('[data-testid="copy-en"]'));
    await A.waitFor(`!!${sel('[data-testid="copy-warning"]')} || window.__copied !== null`);
    if (await A.evaluate(`!!${sel('[data-testid="copy-anyway"]')}`)) await A.click(sel('[data-testid="copy-anyway"]'));
    await A.waitFor(`window.__copied !== null || !!${sel('[data-testid="copy-fallback"] textarea')}`);
    const copied = await A.evaluate(`window.__copied ?? ${sel('[data-testid="copy-fallback"] textarea')}.value`);
    check("copied text: '1. [Q2] …', '2. [Q3] …' (Q1 left out) and the draft reference", copied.includes("\n1. [Q2] ") && copied.includes("\n2. [Q3] ") && !copied.includes("[Q1]") && copied.trim().endsWith(`Reference: ${draftRef} (Q numbers refer to the questions in this message).`), copied.slice(-120));
    await A.click(`document.querySelectorAll('[data-question]')[0].querySelector('[data-testid="include"]')`);
    await A.waitFor(`document.querySelectorAll('[data-question] [data-testid="copied-number"]').length === ${await A.evaluate(`document.querySelectorAll('[data-question] [data-testid="include"]:checked').length`)}`);
    await A.shot("29-01-fresh-record");

    // Reply 1 (linked): no quote version written, no basis change for the draft, source / unverified sender labelled.
    await typeReply(A, REPLY);
    await A.evaluate(setInput(sel('[data-testid="reply-received"]'), "2026-10-27"));
    await A.evaluate(setInput(sel('[data-testid="reply-channel"]'), "e-mail"));
    await A.evaluate(setInput(sel('[data-testid="reply-sender"]'), "Sales (as signed, SYNTHETIC)"));
    await A.click(sel('[data-testid="reply-save"]'));
    await A.waitFor(`${sel('[data-testid="replies"]')}.dataset.replies === "1" && ${sel('[data-testid="replies"]')}.dataset.links === "1"`);
    const c1 = counts();
    check("reply 1 saved and linked; no quote version written", c1.versions === afterSeed.versions && c1.supplierReplies === afterSeed.supplierReplies + 1 && c1.links === afterSeed.links + 1);
    check("reply card: pasted by you, sender not verified, sender as written, received date, channel", await A.evaluate(`(() => { const t = ${card(1)}.innerText; return t.includes("Pasted by you") && t.includes("sender not verified") && t.includes("Sales (as signed, SYNTHETIC)") && t.includes("2026-10-27") && t.includes("e-mail"); })()`));
    check("receiving settles nothing: questions still open; fact 'Reply received (linked)'", await A.evaluate(`[...document.querySelectorAll('[data-testid="reply-question"]')].every((e) => e.dataset.state === "OPEN" && e.querySelector('[data-fact="received"]').innerText === "Reply received (linked)")`));
    await A.goto(draftUrl, "Supplier replies");
    await hydrated(A);
    check("draft shows no basis change after the reply (a reply is not a quote version)", await A.evaluate(`!${sel('[data-testid="basis-changed"]')}`));

    // The same text received again (another day / channel) under a new request: a separate reply, flagged, not merged.
    await typeReply(A, REPLY);
    await A.evaluate(setInput(sel('[data-testid="reply-received"]'), "2026-10-28"));
    await A.evaluate(setInput(sel('[data-testid="reply-channel"]'), "WeChat"));
    await A.click(sel('[data-testid="reply-save"]'));
    await A.waitFor(`${sel('[data-testid="replies"]')}.dataset.replies === "2"`);
    check(
      "same text again → reply 2 kept separately with its own date and channel, flagged 'possible duplicate'",
      await A.evaluate(`${card(2)}.innerText.includes("2026-10-28") && ${card(2)}.innerText.includes("WeChat") && ${card(2)}.querySelector('[data-testid="reply-same-text"]').innerText.includes("reply 1") && ${card(1)}.querySelector('[data-testid="reply-same-text"]').innerText.includes("reply 2")`),
    );
    check("possible-duplicate notice shown on save", await A.evaluate(`${sel('[data-testid="reply-notice"]')}.innerText.includes("possible duplicate")`));

    // An unassigned reply.
    await typeReply(A, UNASSIGNED);
    if (await A.evaluate(`${sel('[data-testid="reply-link-after"]')}.checked`)) await A.click(sel('[data-testid="reply-link-after"]'));
    await A.click(sel('[data-testid="reply-save"]'));
    await A.waitFor(`${sel('[data-testid="replies"]')}.dataset.replies === "3"`);
    check("unassigned reply shown as 'Not assigned to any draft'", await A.evaluate(`${card(3)}.dataset.linked === "no" && ${card(3)}.innerText.includes("Not assigned to any draft")`));

    // Material: wrong excerpt refused; exact excerpt + statement 'proposes a new condition' → updated quote needed.
    const answer = async (tab, q, { reply = null, status, excerpt = null, statement = null, kind = null }) => {
      await tab.click(`${rq(q)}.querySelector('[data-testid="reply-record"]')`);
      await tab.waitFor(`!!${rq(q)}.querySelector('[data-testid="answer-form"]')`);
      // The reply choice exists only when the draft has more than one linked reply.
      if (reply !== null) await tab.evaluate(`(() => { const s = ${rq(q)}.querySelector('[data-testid="answer-reply"]'); if (s) { s.selectedIndex = ${reply}; s.dispatchEvent(new Event("change", { bubbles: true })); } return true; })()`);
      await tab.click(`${rq(q)}.querySelector('[data-status="${status}"]')`);
      if (excerpt !== null) await tab.setText(`${rq(q)}.querySelector('[data-testid="answer-excerpt"]')`, excerpt);
      if (statement !== null) {
        if (!(await tab.evaluate(`${rq(q)}.querySelector('[data-testid="answer-add-statement"]').checked`))) await tab.click(`${rq(q)}.querySelector('[data-testid="answer-add-statement"]')`);
        await tab.evaluate(setInput(`${rq(q)}.querySelector('[data-testid="answer-statement"]')`, statement));
        await tab.click(`${rq(q)}.querySelector('[data-kind="${kind}"]')`);
      }
      await tab.click(`${rq(q)}.querySelector('[data-testid="answer-save"]')`);
    };
    await answer(A, Q.mat, { reply: 0, status: "ANSWERED", excerpt: "材质可改为 304 不锈钢" });
    await A.waitFor(`${rq(Q.mat)}.innerText.includes("does not occur in the saved reply text")`);
    check("excerpt not in the chosen reply: warned and refused, nothing written", counts().answers === c1.answers);
    await A.click(`[...${rq(Q.mat)}.querySelectorAll('[data-testid="answer-form"] button')].find((b) => b.innerText === "Cancel")`);
    await answer(A, Q.mat, { reply: 0, status: "ANSWERED", excerpt: EXCERPT_MAT, statement: "Supplier offers 316 stainless steel; price to be quoted", kind: "PROPOSES_NEW" });
    await A.waitFor(`${rq(Q.mat)}.dataset.state === "STATEMENT_RECORDED"`);
    check(
      "material: statement 'proposes a new condition' → four separate facts: received · reading recorded · quote update needed · not approved",
      await A.evaluate(`(() => { const e = ${rq(Q.mat)}; const f = (k) => e.querySelector('[data-fact="' + k + '"]').innerText; return f("received") === "Reply received (linked)" && f("reviewed") === "Your reading recorded" && f("quote") === "Quote update: needed" && f("approved").includes("not approved") && !!e.querySelector('[data-testid="updated-quote-needed"]') && e.querySelector('[data-testid="reply-statement"]').dataset.kind === "PROPOSES_NEW"; })()`),
    );

    // Payment: classified unclear → manual review, no quote update assumed. Quantity: confirms the quoted condition.
    await answer(A, Q.pay, { reply: 0, status: "ANSWERED", excerpt: EXCERPT_PAY, statement: "30/70, maybe negotiable", kind: "UNCLEAR" });
    await A.waitFor(`${rq(Q.pay)}.dataset.state === "STATEMENT_RECORDED"`);
    check("payment: classified unclear → 'Quote update: manual review'", await A.evaluate(`${rq(Q.pay)}.querySelector('[data-fact="quote"]').innerText === "Quote update: manual review" && !!${rq(Q.pay)}.querySelector('[data-testid="manual-review"]')`));
    await answer(A, Q.qty, { reply: 0, status: "ANSWERED", excerpt: "数量 250 件可以接受", statement: "250 pcs accepted as quoted", kind: "CONFIRMS_ORIGINAL" });
    await A.waitFor(`${rq(Q.qty)}.dataset.state === "STATEMENT_RECORDED"`);
    check("quantity: confirms the quoted condition → 'Quote update: none recorded', still not approved", await A.evaluate(`${rq(Q.qty)}.querySelector('[data-fact="quote"]').innerText === "Quote update: none recorded" && ${rq(Q.qty)}.querySelector('[data-fact="approved"]').innerText.includes("not approved")`));
    await A.shot("29-02-classified");

    // Contradiction: reply 2 (same text, other day) read differently for the material.
    await answer(A, Q.mat, { reply: 1, status: "PARTLY_ANSWERED", excerpt: EXCERPT_MAT });
    await A.waitFor(`${rq(Q.mat)}.dataset.contradiction === "yes"`);
    check("material read differently from reply 2 → contradiction flagged, history kept", await A.evaluate(`${rq(Q.mat)}.dataset.state === "PARTLY_ANSWERED" && !!${rq(Q.mat)}.querySelector('[data-testid="contradiction"]') && ${rq(Q.mat)}.innerText.includes("History (2)")`));

    // Basis change: a review of the draft's extraction run (through the reviews API) → readings must be reviewed again.
    const rv = await A.evaluate(`fetch(${JSON.stringify(`${api}/quotes/${rec.seriesId}/versions/${rec.versionId}/extractions/${rec.runId}/reviews`)}, { method: "POST", headers: { "Content-Type": "application/json", "X-TradeProof-CSRF": (document.cookie.match(/tp_csrf=([^;]+)/) || [])[1] || "" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), fieldPath: "quoteDate", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: null }) }).then((r) => r.status)`);
    await A.goto(draftUrl, "Supplier replies");
    await hydrated(A);
    check(
      "after a review of the draft's run: quantity and payment readings show 'earlier basis' (reviews changed); history unchanged",
      rv === 201 && (await A.evaluate(`[${Q.qty}, ${Q.pay}].every((q) => { const e = document.querySelectorAll('[data-testid="reply-question"]')[q - 1]; return e.dataset.basis === "changed" && e.querySelector('[data-testid="basis-warning"]').dataset.changes.includes("REVIEWS_CHANGED") && e.querySelector('[data-fact="reviewed"]').innerText.includes("earlier basis"); })`)),
      `review HTTP ${rv}`,
    );

    // Updated quote: saved as a quote version (as the composer does), linked explicitly → shown as unverified.
    const saved = await A.evaluate(`fetch(${JSON.stringify(`${api}/quotes/${rec.seriesId}/versions`)}, { method: "POST", headers: { "Content-Type": "application/json", "X-TradeProof-CSRF": (document.cookie.match(/tp_csrf=([^;]+)/) || [])[1] || "" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: ${JSON.stringify(rec.versionId)}, rawText: ${JSON.stringify(NEW_QUOTE)}, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "[TEST] updated quote (SYNTHETIC)", supplierQuoteDate: null, revisionNote: null }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
    await A.goto(draftUrl, "Supplier replies");
    await hydrated(A);
    await A.click(`[...${card(1)}.querySelectorAll("summary")].find((x) => x.innerText.includes("updated quote version"))`);
    await A.waitFor(`!!${card(1)}.querySelector('[data-testid="quote-link-version"]')?.offsetParent`);
    await A.evaluate(`(() => { const s = ${card(1)}.querySelector('[data-testid="quote-link-version"]'); s.value = ${JSON.stringify(saved.body.version?.id ?? "")}; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await A.click(`${card(1)}.querySelector('[data-testid="quote-link-save"]')`);
    await A.waitFor(`!!${card(1)}.querySelector('[data-testid="reply-updated-quotes"] li')`);
    check(
      "updated quote v2 linked → 'extraction: not run · comparison: not verified · approval: not approved'",
      saved.status === 201 && (await A.evaluate(`(() => { const t = ${card(1)}.querySelector('[data-testid="reply-updated-quotes"]').innerText; return t.includes("version 2") && t.includes("extraction: not run") && t.includes("comparison: not verified") && t.includes("approval: not approved"); })()`)),
    );
    check("after saving quote v2 every recorded reading shows 'a newer quote version was saved'", await A.evaluate(`[${Q.qty}, ${Q.pay}, ${Q.mat}].every((q) => document.querySelectorAll('[data-testid="reply-question"]')[q - 1].querySelector('[data-testid="basis-warning"]').dataset.changes.includes("NEWER_QUOTE_VERSION"))`));
    await A.shot("29-03-updated-quote");

    // Stale second tab → conflict, nothing written.
    B = await openTab();
    await B.goto(draftUrl, "Supplier replies");
    await hydrated(B);
    await answer(A, Q.qty, { reply: 0, status: "NOT_ANSWERED" });
    await A.waitFor(`${rq(Q.qty)}.dataset.state === "NOT_ANSWERED"`);
    const beforeStale = counts();
    await answer(B, Q.qty, { reply: 0, status: "PARTLY_ANSWERED", excerpt: "数量 250 件可以接受" });
    await B.waitFor(`${sel('[data-testid="reply-notice"]')}?.innerText.includes("changed in another tab")`);
    await B.waitFor(`${rq(Q.qty)}.dataset.state === "NOT_ANSWERED"`);
    check("stale tab: conflict shown, nothing written, newest answer shown", JSON.stringify(counts()) === JSON.stringify(beforeStale));

    await A.goto(draftUrl, "Supplier replies");
    await hydrated(A);
    const final = await A.evaluate(states());
    check("after reload: everything kept", final.split(",")[Q.qty - 1] === "NOT_ANSWERED" && final.split(",")[Q.mat - 1] === "PARTLY_ANSWERED" && final.split(",")[Q.pay - 1] === "STATEMENT_RECORDED", final);
    writeFileSync(STATE, JSON.stringify({ createdAt: new Date().toISOString(), record: rec, draftUrl, done: true, states: final }, null, 2));
    const all = [...A.requests, ...B.requests];
    const allowed = (r) => /\/quotes\/qs_[^/]+\/replies$/.test(r) || /\/quotes\/qs_[^/]+\/replies\/sr_[^/]+\/quote-links$/.test(r) || /\/clarification-drafts\/cd_[^/]+\/(replies|answers)$/.test(r) || /\/quotes\/qs_[^/]+\/versions$/.test(r) || /\/extractions\/qx_[^/]+\/reviews$/.test(r) || /^POST .*\/_next\//.test(r);
    const unexpected = all.filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !allowed(r));
    check("writes went only to the reply / answer / link / quote-version / review endpoints used above", unexpected.length === 0, unexpected.join(" | ").slice(0, 300) || "(ok)");
    const ext = external(all);
    check("no request to any other host (http / https / ws); data: and blob: icons are not network requests", ext.length === 0, ext.join(" | ").slice(0, 300) || `(none; ${all.filter((r) => /^[A-Z]+ data:/.test(r)).length} data: entries ignored)`);
  } else {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    if (!st.done) throw new Error("the last full run did not finish; nothing to verify");
    edge = spawn(EDGE, args, { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
      await sleep(200);
    }
    await signInBrowser(PORT, BASE, (SESSION = await e2eSession(DB, BASE, null)));
    A = await openTab();
    await A.goto(st.draftUrl, "Supplier replies");
    await hydrated(A);
    check("after restart: the run's replies, links and answers are kept", (await A.evaluate(states())) === st.states && (await A.evaluate(`${sel('[data-testid="replies"]')}.dataset.replies === "3" && !!document.querySelector('[data-testid="reply-updated-quotes"] li')`)));
    check("read-only: opening sent no write", A.requests.filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r)).length === 0, A.requests.join(" | ").slice(0, 200));
    check("no request to any other host", external(A.requests).length === 0, external(A.requests).join(" | "));
    await A.shot("29-04-after-restart");
  }
  check("no console errors", A.errors.length === 0 && (!B || B.errors.length === 0), [...A.errors, ...(B?.errors ?? [])].join(" | ").slice(0, 2000));
  const after = counts();
  const same = (k) => after[k] === afterSeed[k];
  check("ledger, LIVE runs, payments and payment events unchanged; MOCK runs only the seeded one", ["ledger", "settled", "live", "payments", "paymentEvents"].every(same) && after.mock === afterSeed.mock && after.live === before.live, JSON.stringify(after));
  if (VERIFY) check("verify run wrote nothing", JSON.stringify(after) === JSON.stringify(before));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  A?.close();
  B?.close();
  edge?.kill();
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
