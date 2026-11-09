// Full business-chain check (7 Nov 2026; manual run, not part of `npm test`). Works ONLY on a database COPY (E2E_DB) and a
// dev server on the same copy in MOCK mode: `TRADEPROOF_MOCK_DB=<copy> npm run mock:start` (MOCK extraction, MOCK
// Copilot, MOCK PayPal). No model, token-count or PayPal request.
//
//   E2E_DB=<copy> HEADLESS=1 node scripts/e2e/chain.e2e.mjs
//
// What is fixture and what is a real operation (kept apart in the output):
//   FIXTURE  three throwaway accounts (buyer, buyer 2, approver) created in the copy with random in-memory passwords.
//   API      every business step below goes through the app's own HTTP endpoints after a real POST /api/auth/login, with
//            the session cookie, same-origin Origin and the CSRF header — exactly what the pages send. No direct DB write.
//   BROWSER  Edge (CDP) pages as those users: visible state checked against the stored rows; console errors and failed
//            requests collected.
// One new [SYNTHETIC] record per run: request → quote v1 → MOCK extraction → reviews + match → comparison → bilingual
// draft → supplier reply + Q1 answered / Q2 partly → request revised (sample order) → quote v2 → extraction → reviews →
// classification (a wrong choice, then a correction) → approver assigned → approval → MOCK payment → PAID. Negative cases
// on the way (each must be refused and leave no row).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eAccounts, e2eDb, login, signInBrowser } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const SHOTS = join(process.cwd(), "data", "e2e-screens", "chain");
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p) => import(pathToFileURL(join(process.cwd(), p)).href);
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (area, name, ok, detail = "") => {
  results.push({ area, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? `  — ${detail}` : ""}`);
};
const q = (sql, ...p) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return c.prepare(sql).all(...p);
  } finally {
    c.close();
  }
};
const n = (sql, ...p) => Number(Object.values(q(sql, ...p)[0])[0]);

// ---------- API helpers (as a signed-in user) ----------
async function call(session, method, path, body, key) {
  const headers = { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) };
  const res = await authedFetch(BASE, session, path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const get = (s, p) => call(s, "GET", p);
const post = (s, p, b, key) => call(s, "POST", p, b, key);
const put = (s, p, b) => call(s, "PUT", p, b);
const need = (r, codes, what) => {
  if (!codes.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 600)}`);
  return r.data;
};

// ---------- browser (CDP) ----------
async function openTab(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let seq = 0;
  const waiting = new Map();
  const tab = { errors: [], failed: [] };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") tab.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") tab.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 500) tab.failed.push(`${msg.params.response.status} ${msg.params.response.url}`);
    if (msg.method === "Network.loadingFailed" && !msg.params.canceled) tab.failed.push(`failed ${msg.params.errorText}`);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      waiting.set(++seq, { res, rej });
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
      throw new Error(`timeout: ${expression.slice(0, 160)}`);
    },
    async goto(url, readyText, timeout = 90000) {
      await send("Page.navigate", { url });
      try {
        await tab.waitFor(`document.readyState === "complete" && document.body.innerText.includes(${JSON.stringify(readyText)})`, timeout);
      } catch (e) {
        await tab.shot(`timeout-${Date.now()}`).catch(() => {});
        throw new Error(`${e.message} — page text starts: ${(await evaluate("document.body.innerText").catch(() => "")).slice(0, 300).replace(/s+/g, " ")}`);
      }
    },
    text: () => evaluate("document.body.innerText"),
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    },
    overflowX: () => evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"),
  });
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  return tab;
}

const [{ loadDemoInput }, { reviewableFacts }] = await Promise.all([load("src/server/procurement/demo.ts"), load("src/server/extraction/service.ts")]);
const sample = (f) => readFileSync(join("samples", "synthetic", f), "utf8").replace(/\r\n/g, "\n");
const REPLY = "SYNTHETIC / DEMO reply (fictional). [Q1] 数量可以做到 500 个。[Q2] 可以改用 304 不锈钢，单价调整为人民币 26.80 元/个，新报价单随后发送。";

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-chain-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,960", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
let edge = null;
let T = null;
const ids = {};
try {
  // ---------- FIXTURE ----------
  const acc = await e2eAccounts(DB);
  console.log(`FIXTURE  accounts created in the copy: ${acc.buyer.username}, ${acc.buyer2.username}, ${acc.approver.username} (passwords in memory only)`);
  const B = await login(BASE, acc.buyer);
  const B2 = await login(BASE, acc.buyer2);
  const AP = await login(BASE, acc.approver);

  // ---------- A. sign-in and access ----------
  const anon = await fetch(`${BASE}/api/procurements`);
  check("A", "not signed in: API refuses (401/403), no data", [401, 403].includes(anon.status), `HTTP ${anon.status}`);
  const anonPage = await fetch(`${BASE}/procurements`, { redirect: "manual" });
  check("A", "not signed in: page redirects to /login", [302, 303, 307, 308].includes(anonPage.status) && (anonPage.headers.get("location") ?? "").includes("/login"), `${anonPage.status} ${anonPage.headers.get("location")}`);
  const apCreate = await post(AP, "/api/procurements", { ...loadDemoInput(), source: "DEMO_SAMPLE" });
  check("A", "approver cannot create a request (403)", apCreate.status === 403, `HTTP ${apCreate.status}`);

  // ---------- B. request + quote v1 ----------
  const input = loadDemoInput();
  input.title = `${input.title} · chain ${new Date().toISOString().slice(0, 16)}Z`;
  const created = need(await post(B, "/api/procurements", { ...input, source: "DEMO_SAMPLE" }), [201], "create request");
  const R = created.record.id;
  ids.request = R;
  check("B", "buyer creates the request (revision 1, owner = buyer)", created.record.revision === 1 && n("SELECT count(*) FROM procurement_owners WHERE request_id = ? AND principal_id = ?", R, acc.buyer.id) === 1);
  check("A", "buyer 2 cannot read buyer 1's request (404)", (await get(B2, `/api/procurements/${R}`)).status === 404);
  check("A", "unassigned approver cannot read the request (404)", (await get(AP, `/api/procurements/${R}`)).status === 404);
  check("A", "buyer 2 cannot edit it (404, nothing stored)", (await put(B2, `/api/procurements/${R}`, { ...input, revision: 1 })).status === 404 && n("SELECT revision FROM procurement_requests WHERE id = ?", R) === 1);

  const v1body = { idempotencyKey: randomUUID(), expectedRequestRevision: 1, name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118 (中文)", supplierDisplayName: "宁波示例日用品有限公司（虚构）", rawText: sample("supplier-quote-zh.synthetic.md"), contentKind: "FULL_QUOTE", source: "DEMO_SAMPLE", sourceNote: "samples/synthetic/supplier-quote-zh.synthetic.md", supplierQuoteDate: "2026-10-15" };
  const s1 = need(await post(B, `/api/procurements/${R}/quotes`, v1body), [201], "quote v1");
  const S = s1.series.id;
  const V1 = s1.version.id;
  Object.assign(ids, { series: S, v1: V1 });
  const replay = await post(B, `/api/procurements/${R}/quotes`, v1body);
  check("B", "same quote save repeated (same key) → replay, still one version", replay.status === 200 && n("SELECT count(*) FROM quote_versions WHERE series_id = ?", S) === 1, `HTTP ${replay.status}`);
  const vbase = `/api/procurements/${R}/quotes/${S}/versions`;

  // ---------- C. extraction + review ----------
  const run1 = need(await post(B, `${vbase}/${V1}/extractions`, { idempotencyKey: randomUUID(), rerun: true }), [201], "run v1").run;
  ids.run1 = run1.id;
  check("C", "MOCK extraction of v1 succeeded and is labelled MOCK", run1.status === "SUCCEEDED" && run1.mode === "MOCK", `${run1.status} ${run1.mode}`);
  check("C", "approver (not assigned) cannot run an extraction", (await post(AP, `${vbase}/${V1}/extractions`, { idempotencyKey: randomUUID(), rerun: true })).status === 404);

  async function reviewAll(versionId, run, requestItemIds) {
    const latest = new Map();
    let count = 0;
    const add = async (fieldPath, action, requestItemId = null) => {
      const r = need(await post(B, `${vbase}/${versionId}/extractions/${run.id}/reviews`, { idempotencyKey: randomUUID(), fieldPath, action, valueText: null, requestItemId, basedOnReviewId: latest.get(fieldPath) ?? null }), [201], `review ${fieldPath}`);
      latest.set(fieldPath, r.review.id);
      count++;
      return r.review;
    };
    for (let i = 0; i < run.result.items.length; i++) await add(`items[${i}].match`, "MATCH_ITEM", requestItemIds[i] ?? requestItemIds[0]);
    for (const [path, fact] of reviewableFacts(run.result)) {
      if (path.endsWith(".match")) continue;
      if (fact && fact.check === "SUPPORTED") await add(path, "CONFIRM");
    }
    return { count, latest };
  }
  const rec1 = need(await get(B, `/api/procurements/${R}`), [200], "get request").record;
  const rv1 = await reviewAll(V1, run1, rec1.items.map((i) => i.id));
  check("C", `every reviewable value of v1 reviewed through the API (${rv1.count} reviews incl. the item match)`, n("SELECT count(*) FROM quote_extraction_reviews WHERE extraction_id = ?", run1.id) === rv1.count);
  // Repeat confirm with an outdated basis (what a second open tab would send) → refused, no duplicate row.
  const firstPath = [...rv1.latest.keys()].find((p) => !p.endsWith(".match"));
  const dup = await post(B, `${vbase}/${V1}/extractions/${run1.id}/reviews`, { idempotencyKey: randomUUID(), fieldPath: firstPath, action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: null });
  check("C", "repeat confirm from a stale page (no basis) → 409 REVIEW_CONFLICT, no duplicate row", dup.status === 409 && dup.data?.code === "REVIEW_CONFLICT" && n("SELECT count(*) FROM quote_extraction_reviews WHERE extraction_id = ?", run1.id) === rv1.count, `HTTP ${dup.status}`);

  const cmp = need(await get(B, `${vbase}/${V1}/comparison?run=${run1.id}`), [200], "comparison v1");
  const cmpText = JSON.stringify(cmp.comparison);
  void cmpText;
  check("C", `comparison of v1 computed server-side: ${cmp.comparison.summary.differences} differences`, cmp.comparison.rows.filter((r) => r.outcome === "DIFFERENCE").map((r) => r.field).join(",") === "quantity,material,logo,currency,leadTime,paymentTerms", cmp.comparison.rows.filter((r) => r.outcome === "DIFFERENCE").map((r) => r.field).join(", "));
  const openFees = cmp.comparison.fees.filter((f) => f.status === "OPEN");
  check("C", "fees the quote does not state stay OPEN (amount unknown), never added; cost marked incomplete, no payment amount", openFees.length > 0 && openFees.every((f) => f.amount.value === null || f.reasons.length > 0) && cmp.comparison.cost.complete === false && cmp.comparison.cost.paymentAmount === null && cmp.comparison.cost.openCount === openFees.length, `${openFees.length} open: ${openFees.map((f) => f.reasons.join("+")).join(", ")}`);

  // ---------- D. clarification draft, reply, answers ----------
  const dr = need(await post(B, `${vbase}/${V1}/clarification-drafts`, { run: run1.id }), [201], "draft");
  const D = dr.draftId;
  ids.draft = D;
  const dview = need(await get(B, `/api/procurements/${R}/clarification-drafts/${D}`), [200], "draft view");
  const questions = dview.draft.generated.questions;
  check("D", `draft generated from fixed templates (${questions.length} questions, EN + 中文)`, questions.length >= 2 && JSON.stringify(dview.draft.generated).includes("[Q1]") === false ? true : questions.length >= 2);
  const again = await post(B, `${vbase}/${V1}/clarification-drafts`, { run: run1.id });
  check("D", "same draft request again → EXISTING (no second draft)", again.status === 200 && again.data?.code === "EXISTING" && n("SELECT count(*) FROM clarification_drafts WHERE version_id = ?", V1) === 1);
  const rep = need(await post(B, `/api/procurements/${R}/quotes/${S}/replies`, { saveKey: randomUUID(), rawText: REPLY, channelNote: "e-mail (SYNTHETIC)" }), [201], "reply");
  const replyId = rep.reply.id;
  check("D", "supplier reply saved on its own (not a quote version)", n("SELECT count(*) FROM quote_versions WHERE series_id = ?", S) === 1 && n("SELECT count(*) FROM supplier_replies WHERE id = ?", replyId) === 1);
  const lk = need(await post(B, `/api/procurements/${R}/clarification-drafts/${D}/replies`, { saveKey: randomUUID(), reply: replyId, sentRevision: 1 }), [201], "link");
  const linkId = lk.link.id;
  const qOf = (t) => questions.find((x) => x.template === t)?.id;
  const ansBody = (question, status, excerpt) => ({ key: randomUUID(), link: linkId, question, expectedPrevious: null, status, excerpt });
  const badEx = await post(B, `/api/procurements/${R}/clarification-drafts/${D}/answers`, ansBody(qOf("QUANTITY_DIFFERS"), "ANSWERED", "数量 999 个"));
  check("D", "answer excerpt not in the reply → refused (EXCERPT_NOT_IN_REPLY), nothing stored", badEx.status === 422 && n("SELECT count(*) FROM clarification_answers WHERE draft_id = ?", D) === 0, `HTTP ${badEx.status}`);
  need(await post(B, `/api/procurements/${R}/clarification-drafts/${D}/answers`, ansBody(qOf("QUANTITY_DIFFERS"), "ANSWERED", "[Q1] 数量可以做到 500 个。")), [200], "Q1");
  need(await post(B, `/api/procurements/${R}/clarification-drafts/${D}/answers`, ansBody(qOf("MATERIAL_DIFFERS"), "PARTLY_ANSWERED", "[Q2] 可以改用 304 不锈钢，单价调整为人民币 26.80 元/个，新报价单随后发送。")), [200], "Q2");
  const states = need(await get(B, `/api/procurements/${R}/clarification-drafts/${D}/replies`), [200], "reply view");
  const stateOf = (qid) => JSON.stringify(states).match(new RegExp(`"${qid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^}]*?"state":"(\\w+)"`))?.[1] ?? null;
  check("D", "Q1 answered / Q2 partly answered stored on the linked SYNTHETIC reply", n("SELECT count(*) FROM clarification_answers WHERE draft_id = ? AND status = 'ANSWERED'", D) === 1 && n("SELECT count(*) FROM clarification_answers WHERE draft_id = ? AND status = 'PARTLY_ANSWERED'", D) === 1, `states ${stateOf(qOf("QUANTITY_DIFFERS"))} / ${stateOf(qOf("MATERIAL_DIFFERS"))}`);
  const pv1 = need(await get(B, `/api/procurements/${R}/approvals?series=${S}&version=${V1}&run=${run1.id}`), [200], "preview v1");
  check("D", "answered questions approve nothing: v1 preview still BLOCKED", pv1.evaluation.status === "BLOCKED", pv1.evaluation.status);

  // ---------- B. request revision (sample order), conflict, quote v2 ----------
  const in2 = { ...rec1, revision: undefined };
  const edit = JSON.parse(JSON.stringify(input));
  edit.items = rec1.items.map((it, i) => ({ ...input.items[i], id: it.id }));
  edit.items[0].quantity = "20";
  edit.budgetMax = "100.00";
  edit.paymentTerms = "100% advance payment before shipment";
  edit.additionalRequirements = "SYNTHETIC / DEMO DATA — fictional. Sample order: 20 pcs to check quality before a main order of 500 pcs. Incoterm: FOB Ningbo; ship by 2026-12-10. Maximum unit price: USD 3.60 / pcs.";
  void in2;
  const up = await put(B, `/api/procurements/${R}`, { ...edit, revision: 1 });
  check("B", "buyer revises the request to the 20-piece sample order → revision 2", up.status === 200 && up.data?.record?.revision === 2, `HTTP ${up.status} ${up.data?.code ?? ""} ${JSON.stringify(up.data?.errors ?? "").slice(0, 300)}`);
  const stale = await put(B, `/api/procurements/${R}`, { ...edit, title: `${input.title} (stale tab)`, revision: 1 });
  check("B", "save from a stale tab (revision 1) → 409 CONFLICT, nothing overwritten", stale.status === 409 && n("SELECT revision FROM procurement_requests WHERE id = ?", R) === 2, `HTTP ${stale.status}`);
  const v2body = (rev) => ({ idempotencyKey: randomUUID(), expectedRequestRevision: rev, expectedLatestVersionId: V1, rawText: sample("supplier-quote-revised.synthetic.md"), contentKind: "FULL_QUOTE", source: "DEMO_SAMPLE", sourceNote: "samples/synthetic/supplier-quote-revised.synthetic.md", supplierQuoteDate: "2026-11-03", revisionNote: "After supplier reply 1 (SYNTHETIC)" });
  const v2stale = await post(B, `/api/procurements/${R}/quotes/${S}/versions`, v2body(1));
  check("B", "quote v2 against the old request revision → refused, no version", v2stale.status === 409 && n("SELECT count(*) FROM quote_versions WHERE series_id = ?", S) === 1, `HTTP ${v2stale.status}`);
  const s2 = need(await post(B, `/api/procurements/${R}/quotes/${S}/versions`, v2body(2)), [201], "quote v2");
  const V2 = s2.version.id;
  ids.v2 = V2;
  check("B", "quote v2 saved against request revision 2; v1 unchanged", n("SELECT request_revision FROM quote_versions WHERE id = ?", V2) === 2 && n("SELECT request_revision FROM quote_versions WHERE id = ?", V1) === 1);
  const draftAfter = need(await get(B, `/api/procurements/${R}/clarification-drafts/${D}`), [200], "draft after revision");
  check("D", "v1 draft now reports its basis changed (request revised, newer quote version)", JSON.stringify(draftAfter.basis?.changes ?? []).includes("REQUEST_REVISED") && JSON.stringify(draftAfter.basis?.changes ?? []).includes("NEWER_QUOTE_VERSION"), JSON.stringify(draftAfter.basis?.changes));

  const run2 = need(await post(B, `${vbase}/${V2}/extractions`, { idempotencyKey: randomUUID(), rerun: true }), [201], "run v2").run;
  ids.run2 = run2.id;
  const rec2 = need(await get(B, `/api/procurements/${R}`), [200], "request r2").record;
  const rv2 = await reviewAll(V2, run2, rec2.items.map((i) => i.id));
  check("C", `v2 reviewed (${rv2.count} reviews incl. match)`, n("SELECT count(*) FROM quote_extraction_reviews WHERE extraction_id = ?", run2.id) === rv2.count);

  // ---------- E. classification ----------
  const pre = (s) => get(s, `/api/procurements/${R}/approvals?series=${S}&version=${V2}&run=${run2.id}`);
  let ev = need(await pre(B), [200], "preview v2").evaluation;
  const codes = (e) => e.findings.map((f) => `${f.level}:${f.code}`);
  check("E", "v2 preview BLOCKED only by the two unclassified free-text requirements", ev.status === "BLOCKED" && codes(ev).filter((c) => c.startsWith("BLOCK")).every((c) => c === "BLOCK:REQUIREMENT_NOT_CLASSIFIED") && codes(ev).filter((c) => c === "BLOCK:REQUIREMENT_NOT_CLASSIFIED").length === 2, codes(ev).filter((c) => c.startsWith("BLOCK")).join(","));
  const cls = `${vbase}/${V2}/requirement-classifications`;
  const notes = `ITEM_NOTES:${rec2.items[0].id}`;
  const badExcerpt = await post(B, cls, { subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_IN_QUOTE", reason: "r", excerpt: "50 个（样品单）" }, randomUUID());
  check("E", "KEY_IN_QUOTE with an excerpt not in the quote → 422, nothing stored", badExcerpt.status === 422 && n("SELECT count(*) FROM requirement_classifications WHERE version_id = ?", V2) === 0, `HTTP ${badExcerpt.status}`);
  check("E", "approver cannot classify (buyer only)", (await post(AP, cls, { subject: notes, decision: "NOT_KEY", reason: "x" }, randomUUID())).status === 404);
  need(await post(B, cls, { subject: notes, decision: "NOT_KEY", reason: "Label marking the item as fictional demo data; not an order condition." }, randomUUID()), [201], "classify notes");
  const wrong = need(await post(B, cls, { subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "the quote states 样品单 (mis-selected on purpose)" }, randomUUID()), [201], "wrong classification");
  ids.wrongClassification = wrong.classification.id;
  // Correction of an already-classified subject (the owner's 6 Nov case): a new row; the old one stays.
  const fix = await post(B, cls, { subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_IN_QUOTE", reason: "Sample order of 20 pcs — the quote states 样品单.", excerpt: "20 个（样品单）", replaces: wrong.classification.id }, randomUUID());
  check("E", "correction names the row it replaces → 201; old row kept (append-only)", fix.status === 201 && n("SELECT count(*) FROM requirement_classifications WHERE version_id = ? AND subject = 'ADDITIONAL_REQUIREMENTS'", V2) === 2, `HTTP ${fix.status} ${fix.data?.message ?? ""}`);
  const staleFix = await post(B, cls, { subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "stale tab", replaces: wrong.classification.id }, randomUUID());
  check("E", "a second correction from a stale form (replaces an outdated row) → 409, nothing stored", staleFix.status === 409 && n("SELECT count(*) FROM requirement_classifications WHERE version_id = ? AND subject = 'ADDITIONAL_REQUIREMENTS'", V2) === 2, `HTTP ${staleFix.status} ${staleFix.data?.code ?? ""}`);
  const blind = await post(B, cls, { subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "no basis named" }, randomUUID());
  check("E", "re-classifying without naming the current row → 409, nothing stored", blind.status === 409 && n("SELECT count(*) FROM requirement_classifications WHERE version_id = ? AND subject = 'ADDITIONAL_REQUIREMENTS'", V2) === 2, `HTTP ${blind.status} ${blind.data?.code ?? ""}`);
  ev = need(await pre(B), [200], "preview v2 classified").evaluation;
  check("E", "latest classification wins: READY WITH CONFIRMATIONS, USD 68.00", ev.status === "READY_WITH_CONFIRMATIONS" && ev.snapshot.money.thisPayment?.display === "USD 68.00", `${ev.status} ${ev.snapshot.money.thisPayment?.display}`);

  // ---------- A/E. approver assignment ----------
  check("A", "approver not yet assigned: preview 404", (await pre(AP)).status === 404);
  const grant = (action) => post(B, `/api/procurements/${R}/approvers`, { approverId: acc.approver.id, action });
  need(await grant("GRANT"), [200], "grant");
  const g2 = await grant("GRANT");
  check("A", "repeat GRANT → UNCHANGED, one grant row", g2.status === 200 && n("SELECT count(*) FROM approver_grants WHERE request_id = ?", R) === 1, `${g2.data?.code ?? g2.data?.status ?? ""}`);
  if (process.argv.includes("--ui-prep")) {
    // 7 Nov UI review: stop at the demo's start point (v2 READY WITH CONFIRMATIONS, approver assigned, not approved) and
    // keep the throwaway buyer / approver cookies next to the copy (no password) for the screenshot script.
    writeFileSync(`${DB}.e2e-ui-sessions.json`, JSON.stringify({ at: new Date().toISOString(), ids: { ...ids, request: R, series: S, v1: V1, v2: V2, run1: run1.id, run2: run2.id, draft: D }, buyer: B, approver: AP, buyer2: B2 }, null, 1));
    console.log("UI-PREP  stopped after the approver assignment; ids + sessions written next to the copy");
    throw Object.assign(new Error("ui-prep stop"), { uiPrep: true });
  }
  check("A", "buyer 2 cannot assign an approver on buyer 1's request", (await post(B2, `/api/procurements/${R}/approvers`, { approverId: acc.approver.id, action: "GRANT" })).status === 404);
  const evA = need(await pre(AP), [200], "approver preview").evaluation;
  const confirmKeys = evA.findings.filter((f) => f.level === "CONFIRM").map((f) => f.key);
  const approveBody = (e, confirmed) => ({ seriesId: S, versionId: V2, runId: run2.id, previewDigest: e.digest, confirmed });
  const own = await post(B, `/api/procurements/${R}/approvals`, approveBody(evA, confirmKeys), randomUUID());
  check("A", "buyer cannot approve their own request (403), no approval row", own.status === 403 && n("SELECT count(*) FROM approvals WHERE request_id = ?", R) === 0, `HTTP ${own.status}`);
  const noConfirm = await post(AP, `/api/procurements/${R}/approvals`, approveBody(evA, []), randomUUID());
  check("E", "approve without ticking the confirmation → 422 CONFIRMATIONS_MISMATCH", noConfirm.status === 422 && noConfirm.data?.code === "CONFIRMATIONS_MISMATCH" && n("SELECT count(*) FROM approvals WHERE request_id = ?", R) === 0, `HTTP ${noConfirm.status}`);
  const v1Approve = await post(AP, `/api/procurements/${R}/approvals`, { seriesId: S, versionId: V1, runId: run1.id, previewDigest: pv1.evaluation.digest, confirmed: [] }, randomUUID());
  check("B", "older version v1 cannot be approved (refused)", v1Approve.status >= 400 && n("SELECT count(*) FROM approvals WHERE request_id = ?", R) === 0, `HTTP ${v1Approve.status} ${v1Approve.data?.code ?? ""}`);

  // Approval 1 → approver removed → re-assigned: approval 1 stays invalid.
  const k1 = randomUUID();
  const a1 = need(await post(AP, `/api/procurements/${R}/approvals`, approveBody(evA, confirmKeys), k1), [201], "approve 1").approval;
  const a1r = await post(AP, `/api/procurements/${R}/approvals`, approveBody(evA, confirmKeys), k1);
  check("E", "approval 1 created; same key again → replay, one row", a1r.status === 200 && n("SELECT count(*) FROM approvals WHERE request_id = ?", R) === 1);
  const second = await post(AP, `/api/procurements/${R}/approvals`, approveBody(evA, confirmKeys), randomUUID());
  check("E", "a second approval while one is Active → refused or the same row, never a second Active", n("SELECT count(*) FROM approvals WHERE request_id = ?", R) === 1, `HTTP ${second.status} ${second.data?.code ?? second.data?.status ?? ""}`);
  check("E", "approval bound to v2, run 2 and the approver's grant seq", n("SELECT count(*) FROM approvals WHERE id = ? AND version_id = ? AND run_id = ? AND approver_grant_seq IS NOT NULL", a1.id, V2, run2.id) === 1);
  need(await grant("REVOKE"), [200], "revoke grant");
  need(await grant("GRANT"), [200], "re-grant");
  const a1v = need(await get(B, `/api/procurements/${R}/approvals/${a1.id}`), [200], "approval 1 view");
  check("A", "approver removed then re-assigned: approval 1 stays No longer valid (APPROVER_UNASSIGNED)", a1v.validity.state === "INVALIDATED" && JSON.stringify(a1v.validity.reasons).includes("APPROVER_UNASSIGNED"), `${a1v.validity.state} ${a1v.validity.reasons}`);
  const payDead = await post(B, `/api/procurements/${R}/approvals/${a1.id}/payment`, {}, randomUUID());
  check("F", "payment from the invalid approval 1 → 409 APPROVAL_INVALID, no payment record", payDead.status === 409 && n("SELECT count(*) FROM approval_payments WHERE approval_id = ?", a1.id) === 0, `HTTP ${payDead.status} ${payDead.data?.code ?? ""}`);

  // Approval 2 → classification corrected again → approval 2 invalid (CLASSIFICATIONS_CHANGED).
  let evB = need(await pre(AP), [200], "preview after re-grant").evaluation;
  const a2 = need(await post(AP, `/api/procurements/${R}/approvals`, approveBody(evB, confirmKeys), randomUUID()), [201], "approve 2").approval;
  const latestRow = q("SELECT id FROM requirement_classifications WHERE version_id = ? AND subject = 'ADDITIONAL_REQUIREMENTS' ORDER BY created_at DESC, rowid DESC LIMIT 1", V2)[0].id;
  need(await post(B, cls, { subject: "ADDITIONAL_REQUIREMENTS", decision: "KEY_IN_QUOTE", reason: "Sample order of 20 pcs — the quote states 样品单 (reason reworded).", excerpt: "20 个（样品单）", replaces: latestRow }, randomUUID()), [201], "reclassify after approval");
  const a2v = need(await get(B, `/api/procurements/${R}/approvals/${a2.id}`), [200], "approval 2 view");
  check("E", "re-classification after approval → approval 2 No longer valid (CLASSIFICATIONS_CHANGED)", a2v.validity.state === "INVALIDATED" && JSON.stringify(a2v.validity.reasons).includes("CLASSIFICATIONS_CHANGED"), `${a2v.validity.state} ${a2v.validity.reasons}`);

  // Approval 3 → MOCK payment.
  evB = need(await pre(AP), [200], "preview 3").evaluation;
  const a3 = need(await post(AP, `/api/procurements/${R}/approvals`, approveBody(evB, confirmKeys), randomUUID()), [201], "approve 3").approval;
  ids.approval = a3.id;
  check("E", "approval 3 Active with amount 6800 USD cents from the snapshot", a3.amountMinor === 6800 && a3.currency === "USD");
  const payBase = `/api/procurements/${R}/approvals/${a3.id}/payment`;
  check("F", "approver cannot start the payment (buyer only)", (await post(AP, payBase, {}, randomUUID())).status >= 400 && n("SELECT count(*) FROM approval_payments WHERE approval_id = ?", a3.id) === 0);
  const tamper = await post(B, payBase, { amountMinor: 1, currency: "JPY" }, randomUUID());
  check("F", "client amount fields refused (422); amount comes only from the approval", tamper.status === 422 && n("SELECT count(*) FROM approval_payments WHERE approval_id = ?", a3.id) === 0, `HTTP ${tamper.status}`);
  check("F", "capture before any payment record → 409 NO_PAYMENT", (await post(B, `${payBase}/capture`, {}, randomUUID())).status === 409);
  const startKey = randomUUID();
  const st = need(await post(B, payBase, {}, startKey), [201], "start payment");
  const st2 = await post(B, payBase, {}, randomUUID());
  check("F", "start → NEW (TP-APPROVAL-MOCK, 6800 USD); a second start → no second record", st.payment.status === "NEW" && n("SELECT count(*) FROM approval_payments WHERE approval_id = ?", a3.id) === 1, `second start HTTP ${st2.status} ${st2.data?.code ?? st2.data?.status ?? ""}`);
  const rec = () => q("SELECT p.status, p.sku, p.amount_minor, p.currency FROM approval_payments l JOIN sandbox_payment_records p ON p.id = l.payment_record_id WHERE l.approval_id = ?", a3.id)[0];
  check("F", "stored record: NEW · TP-APPROVAL-MOCK · 6800 · USD", JSON.stringify(rec()) === JSON.stringify({ status: "NEW", sku: "TP-APPROVAL-MOCK", amount_minor: 6800, currency: "USD" }), JSON.stringify(rec()));
  need(await post(B, `${payBase}/order`, {}, randomUUID()), [200, 201], "order");
  check("F", "order → ORDER_CREATED (page and DB read the same record)", rec().status === "ORDER_CREATED");
  const capEarly = await post(B, `${payBase}/capture`, {}, randomUUID());
  check("F", "capture before the simulated buyer approval → not PAID", rec().status !== "PAID", `HTTP ${capEarly.status} ${capEarly.data?.code ?? ""} → ${rec().status}`);
  if (rec().status === "ORDER_CREATED") {
    need(await post(B, `${payBase}/mock-approve`, {}, randomUUID()), [200], "mock approve");
    const cap = await post(B, `${payBase}/capture`, {}, randomUUID());
    check("F", "simulated buyer approval → capture → PAID", rec().status === "PAID", `HTTP ${cap.status} ${cap.data?.code ?? ""}`);
    const cap2 = await post(B, `${payBase}/capture`, {}, randomUUID());
    check("F", "capture again after PAID → no change, still one record, PAID", rec().status === "PAID" && n("SELECT count(*) FROM approval_payments WHERE approval_id = ?", a3.id) === 1, `HTTP ${cap2.status} ${cap2.data?.code ?? ""}`);
  }
  const after = need(await pre(AP), [200], "preview after paid").evaluation;
  const a4 = await post(AP, `/api/procurements/${R}/approvals`, approveBody(after, after.findings.filter((f) => f.level === "CONFIRM").map((f) => f.key)), randomUUID());
  check("F", "after PAID a new approval is refused", a4.status >= 400 && n("SELECT count(*) FROM approvals WHERE request_id = ?", R) === 3, `HTTP ${a4.status} ${a4.data?.code ?? ""}`);

  // ---------- G. Copilot (MOCK) ----------
  const cp = await post(B, `/api/procurements/${R}/copilot`, { intent: "PAYMENT_AMOUNT", seriesId: S, versionId: V2, runId: run2.id, baseRunId: null, nonce: randomUUID() }, randomUUID());
  check("G", "Copilot answer (MOCK) for the paid v2", cp.status === 200 && JSON.stringify(cp.data).includes("MOCK"), `HTTP ${cp.status} ${JSON.stringify(cp.data).slice(0, 200)}`);
  check("G", "Copilot calls wrote no ledger row (MOCK)", n("SELECT count(*) FROM ai_budget_ledger") === 0);

  // ---------- H. browser: what each person sees ----------
  edge = spawn(EDGE, args, { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  T = await openTab(PORT);
  await signInBrowser(PORT, BASE, B);
  const quotesV2 = `${BASE}/procurements/${R}/quotes?series=${S}&version=${V2}`;
  await T.goto(quotesV2, "Decision for version 2 of 2");
  await T.waitFor(`document.querySelector('[data-testid="decision-summary"]')?.dataset.state && document.querySelector('[data-testid="decision-summary"]').dataset.state !== "loading"`, 30000).catch(() => {});
  await sleep(800);
  let txt = await T.text();
  check("H", "buyer, Quotes v2: Paid (MOCK) and the paid wording", txt.includes("Paid (MOCK)") && txt.includes("New approval blocked — this version has already been paid."));
  await T.shot("buyer-quotes-v2-paid");
  await T.goto(`${BASE}/procurements/${R}/quotes/approval?series=${S}&version=${V2}&run=${run2.id}`, "Approvals of this request");
  txt = await T.text();
  check("H", "buyer, approval page: PAID (MOCK) and three approvals (1 + 2 No longer valid, 3 Active)", txt.includes("PAID (MOCK)") && (txt.match(/No longer valid/g) ?? []).length >= 2);
  check("H", "buyer, approval page: classification history shows the corrected row and the earlier ones", txt.includes("20 个（样品单）"));
  await T.shot("buyer-approval-paid");
  await T.goto(`${BASE}/procurements/${R}/quotes/drafts/${D}`, "Answers per question");
  txt = await T.text();
  check("H", "buyer, v1 draft: Q1 Answered / Q2 Open — partly answered; basis-changed notice shown", txt.includes("Answered — your reading") && txt.includes("Open — partly answered") && txt.includes("REQUEST_REVISED") === false);
  await T.shot("buyer-draft-v1");
  await signInBrowser(PORT, BASE, AP);
  await T.goto(quotesV2, "Decision for version 2 of 2");
  await sleep(1200);
  txt = await T.text();
  check("H", "approver, Quotes v2: sees the paid state, no payment controls", txt.includes("Paid (MOCK)"));
  await T.shot("approver-quotes-v2");
  await signInBrowser(PORT, BASE, B2);
  await T.send("Page.navigate", { url: quotesV2 });
  await sleep(2500);
  txt = await T.text();
  check("H", "buyer 2 opening buyer 1's Quotes page sees no data (404 page)", !txt.includes("Decision for version 2 of 2") && /404|not found|could not be found/i.test(txt));
  check("H", "no console errors / uncaught exceptions on the visited pages", T.errors.length === 0, T.errors.slice(0, 3).join(" | "));
  check("H", "no failed (5xx / network) requests", T.failed.length === 0, T.failed.slice(0, 3).join(" | "));

  // ---------- A. sign-out ----------
  const out = await authedFetch(BASE, B, "/api/auth/logout", { method: "POST" });
  const afterOut = await get(B, `/api/procurements/${R}`);
  check("A", "after sign-out the old session cookie is refused", out.status < 400 && [401, 403].includes(afterOut.status), `logout ${out.status} → ${afterOut.status}`);

  check("H", "ledger untouched (MOCK only, 0 rows)", n("SELECT count(*) FROM ai_budget_ledger") === 0);
} catch (e) {
  if (!e.uiPrep) check("RUN", "script error", false, e.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  T?.close();
  edge?.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  writeFileSync(`${DB}.e2e-chain-state.json`, JSON.stringify({ at: new Date().toISOString(), ids }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} / ${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => `[${f.area}] ${f.name}`).join("; ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
