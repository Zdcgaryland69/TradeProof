// Browser check for the 31 Oct usability round (manual run, not part of `npm test`). Works ONLY on a database COPY
// (E2E_DB); the dev server must run on the same copy (TRADEPROOF_DB_PATH=<copy>, payment switch off). Creates its own
// e2e buyer / approver accounts in the copy and seeds NEW [TEST] SYNTHETIC records (MOCK replay runs, no model call):
//   1. Quotes page approval entry — owner sees preview + status only (no approve), assigned approver gets the approve
//      link; the link names the selected version and an explicit run; an older version is never switched to the
//      latest; a version without a usable run shows why and offers no preview link.
//   2. v17 in the browser: assign → approve → remove → re-assign → the old approval stays No longer valid; approving
//      again makes a NEW Active approval (sequence ordering itself is covered by tests/access.test.ts). After approving,
//      "Approved — Active" (read back from the server) replaces the button; a double click adds one row; a read-back
//      failure says "saved, refresh failed" and posts nothing again; the server still refuses a second Active approval.
//   3. Draft question card → supplier reply form: scrolls + focuses the form, shows the draft and the Q number; writes
//      nothing, changes no question state.
//   4. "Save clarification draft" vs "Save supplier reply": labels, success / no-change / failure / conflict notices.
//
//   E2E_DB=<copy> node scripts/e2e/usability.e2e.mjs          HEADLESS=1 for headless Edge
//
// No model, token-count or PayPal request. Screenshots in data/e2e-screens/ (Git-ignored).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authedFetch, e2eDb, e2eSession, grantApprover, login, principalOf, signInBrowser } from "./lib/e2e-auth.mjs";
import { seedApprovalSet } from "./seed-approval.mjs";
import { seedReplyRecord } from "./seed-replies.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const SHOTS = join(process.cwd(), "data", "e2e-screens");
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
      payments: n("SELECT count(*) AS n FROM sandbox_payment_records"),
      paymentEvents: n("SELECT count(*) AS n FROM sandbox_payment_events"),
      approvalPayments: n("SELECT count(*) AS n FROM approval_payments"),
      approvals: n("SELECT count(*) AS n FROM approvals"),
      draftRevisions: n("SELECT count(*) AS n FROM clarification_draft_revisions"),
      replies: n("SELECT count(*) AS n FROM supplier_replies"),
      links: n("SELECT count(*) AS n FROM clarification_replies"),
      answers: n("SELECT count(*) AS n FROM clarification_answers"),
      versions: n("SELECT count(*) AS n FROM quote_versions"),
    };
  } finally {
    c.close();
  }
};
const rows = (sql, ...params) => {
  const c = new DatabaseSync(DB, { readOnly: true });
  try {
    return c.prepare(sql).all(...params);
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
      throw new Error(`timeout: ${expression.slice(0, 160)}`);
    },
    async goto(url, readyExpression) {
      await send("Page.bringToFront");
      await send("Page.navigate", { url });
      await tab.waitFor(`document.readyState === "complete" && (${readyExpression})`);
    },
    async click(expression) {
      await send("Page.bringToFront");
      const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: r.top >= 0 && r.bottom <= innerHeight && (e === hit || e.contains(hit)) }; })()`);
      if (!box?.ok) throw new Error(`not clickable on screen: ${expression.slice(0, 140)}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
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
  return tab;
}

const sel = (css) => `document.querySelector(${JSON.stringify(css)})`;
const text = (css) => `(${sel(css)}?.innerText ?? "")`;
const ENTRY = '[data-testid="quote-approval-entry"]';
const reactReady = (css) => `(() => { const e = document.querySelector(${JSON.stringify(css)}); return !!e && Object.keys(e).some((k) => k.startsWith("__reactFiber")); })()`;
const writes = (tab, from) => tab.requests.slice(from).filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !/\/_next\//.test(r));
const LOCAL = [BASE, BASE.replace(/^http/, "ws")];
const external = (reqs) => reqs.map((r) => r.replace(/^[A-Z]+ /, "")).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:") && !LOCAL.some((l) => u.startsWith(l)));
const query = (href) => Object.fromEntries(new URL(href, BASE).searchParams);

const profile = mkdtempSync(join(tmpdir(), "tradeproof-e2e-usability-"));
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1366,860", "about:blank"];
if (process.env.HEADLESS === "1") args.unshift("--headless=new");
let T;
let edge = null;
const before = counts();
let afterSeed = before;
try {
  const SESSION = await e2eSession(DB, BASE, null);
  const APPROVER = await login(BASE, { username: SESSION.accounts.approver.username, password: SESSION.passwords.approver });
  const approverId = SESSION.accounts.approver.id;
  process.env.SEED_DB = DB;
  const owner = await principalOf(DB, SESSION.account.username);
  let a;
  let rec;
  try {
    a = (await seedApprovalSet("e2e usability", BASE, ["A"], { principal: owner.principal, id: owner.principal.id })).cases.A;
    rec = await seedReplyRecord("e2e usability replies", { principal: owner.principal, id: owner.principal.id });
  } finally {
    owner.close();
  }
  afterSeed = counts();
  check("seeded 2 new [TEST] SYNTHETIC records (2 MOCK runs, 1 draft); no LIVE run, no budget row, no payment", afterSeed.mock === before.mock + 2 && afterSeed.live === before.live && afterSeed.ledger === before.ledger && afterSeed.payments === before.payments);
  const quotesUrl = `${BASE}/procurements/${a.requestId}/quotes?series=${a.seriesId}&version=${a.versionId}`;

  edge = spawn(EDGE, args, { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  await signInBrowser(PORT, BASE, SESSION);
  T = await openTab();

  // ---------- 1. Quotes page entry: owner, no approver yet ----------
  let mark = T.requests.length;
  await T.goto(quotesUrl, `!!document.querySelector('${ENTRY}[data-state="preview"]')`);
  const ownerHref = await T.evaluate(`${sel('[data-testid="entry-status-link"]')}?.getAttribute("href") ?? ""`);
  check(
    "owner: entry shows preview + status link, NO approve link; 'no approver assigned' stated",
    (await T.evaluate(`${sel(ENTRY)}.dataset.role`)) === "OWNER" && ownerHref !== "" && !(await T.evaluate(`!!${sel('[data-testid="entry-approve-link"]')}`)) && (await T.evaluate(`!!${sel('[data-testid="entry-no-approver"]')}`)),
  );
  check("owner: link names the selected version and the explicit seeded run", JSON.stringify(query(ownerHref)) === JSON.stringify({ series: a.seriesId, version: a.versionId, run: a.runId }), ownerHref);
  check("owner: entry names the run on the page", (await T.evaluate(text('[data-testid="entry-run"]'))).includes(a.runId.slice(0, 11)));
  await T.shot("31-usab-01-owner-entry-no-approver");
  await grantApprover(BASE, SESSION, a.requestId, approverId);
  await T.goto(quotesUrl, `!!document.querySelector('${ENTRY}[data-state="preview"]')`);
  check("owner: after assigning the approver the 'no approver' note is gone", !(await T.evaluate(`!!${sel('[data-testid="entry-no-approver"]')}`)));
  await T.click(sel('[data-testid="entry-status-link"]'));
  await T.waitFor(`location.pathname.endsWith("/quotes/approval") && !!${sel('[data-testid="approval-status"]')}`);
  const ownerLanding = await T.evaluate("location.href");
  check("owner: approval page opened for the same version and run (no redirect to another run)", JSON.stringify(query(ownerLanding)) === JSON.stringify({ series: a.seriesId, version: a.versionId, run: a.runId }), ownerLanding);
  check("owner: preview READY, but no Approve button — 'only the assigned approver' note", (await T.evaluate(`${sel('[data-testid="approval-status"]')}.dataset.status`)) === "READY" && !(await T.evaluate(`!!${sel('[data-testid="approve"]')}`)) && (await T.evaluate(`!!${sel('[data-testid="approve-not-allowed"]')}`)));
  check("owner: opening the Quotes entry and the preview wrote nothing", writes(T, mark).length === 0, writes(T, mark).join(" | "));

  // ---------- 1b / 2. approver: entry → approve; v17 remove / re-assign ----------
  await signInBrowser(PORT, BASE, APPROVER);
  await T.goto(quotesUrl, `!!document.querySelector('${ENTRY}[data-state="preview"]')`);
  const apprHref = await T.evaluate(`${sel('[data-testid="entry-approve-link"]')}?.getAttribute("href") ?? ""`);
  check("approver: entry offers 'Review and approve this version', same version + run; no extraction controls", (await T.evaluate(`${sel(ENTRY)}.dataset.role`)) === "APPROVER" && JSON.stringify(query(apprHref)) === JSON.stringify({ series: a.seriesId, version: a.versionId, run: a.runId }) && (await T.evaluate(`!!${sel('[data-testid="extraction-readonly"]')}`)));
  await T.shot("31-usab-02-approver-entry");
  await T.click(sel('[data-testid="entry-approve-link"]'));
  await T.waitFor(`location.pathname.endsWith("/quotes/approval") && ${reactReady('[data-testid="approve"]')}`);
  const n0 = counts().approvals;
  mark = T.requests.length;
  // Two clicks in the same task (before React re-renders): both may post, with the form's one request key.
  // The button is first brought on screen, as a person would see it before clicking.
  await T.evaluate(`(() => { const b = ${sel('[data-testid="approve"]')}; b.scrollIntoView({ block: "center" }); b.click(); b.click(); return true; })()`);
  await T.waitFor(`!!document.querySelector('[data-testid="approve-result"][data-state="ACTIVE"], [data-testid="approved-active"]')`);
  const fb = await T.evaluate(`(() => { const e = document.querySelector('[data-testid="approve-result"], [data-testid="approved-active"]'); const r = e.getBoundingClientRect(); return { text: e.innerText, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, onScreen: r.top >= 0 && r.bottom <= innerHeight, inStatus: !!e.closest('[data-testid="approval-status"]') }; })()`);
  check("approver: after approving, 'Approved — Active' shows on screen where the button was; no Approve button", fb.text.includes("Approved — Active") && fb.onScreen && fb.inStatus && !(await T.evaluate(`!!${sel('[data-testid="approve"]')}`)), JSON.stringify(fb).slice(0, 160));
  await T.waitFor(`!!${sel('[data-testid="approved-active"]')}`);
  const posts = writes(T, mark).filter((r) => r.endsWith("/approvals")).length;
  check("double click: one approval row (server idempotency), Active read back from the server", counts().approvals === n0 + 1 && posts >= 1 && posts <= 2, `POSTs ${posts}`);
  check("approver: Active notice links to the approval history", (await T.evaluate(`${sel('[data-testid="approved-history-link"]')}?.getAttribute("href")`)) === "#approval-history" && (await T.evaluate(`!!document.getElementById("approval-history")`)));
  await T.shot("31-usab-02b-approved-active");
  const first = await T.evaluate(`document.querySelector('[data-approval][data-state="ACTIVE"]').dataset.approval`);
  await T.goto(a.approvalUrl, `!!${sel('[data-testid="approved-active"]')}`);
  check("approver: after a reload the page still shows 'Approved — Active' (server state), no Approve button", (await T.evaluate(`${sel('[data-testid="approved-active"]')}.dataset.activeApproval`)) === first && !(await T.evaluate(`!!${sel('[data-testid="approve"]')}`)));
  const pv = await authedFetch(BASE, APPROVER, `/api/procurements/${a.requestId}/approvals?series=${a.seriesId}&version=${a.versionId}&run=${a.runId}`).then((r) => r.json());
  const again = await authedFetch(BASE, APPROVER, `/api/procurements/${a.requestId}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ seriesId: a.seriesId, versionId: a.versionId, runId: a.runId, baseRunId: null, previewDigest: pv.evaluation?.digest, confirmed: [] }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("server, not the hidden button, prevents a second row: a NEW request key on the same basis → EXISTING (the same approval), no new row", again.status === 200 && again.body?.status === "EXISTING" && again.body?.approval?.id === first && counts().approvals === n0 + 1, `${again.status} ${again.body?.status ?? again.body?.code}`);

  await signInBrowser(PORT, BASE, SESSION);
  await T.goto(`${BASE}/procurements/${a.requestId}`, reactReady('[data-testid="access-panel"]'));
  await T.click(`[...document.querySelectorAll('[data-testid="approver-row"]')].find((r) => r.innerText.includes(${JSON.stringify(SESSION.accounts.approver.displayName)})).querySelector('[data-testid="approver-revoke"]')`);
  await T.waitFor(`[...document.querySelectorAll('[data-testid="approver-row"]')].some((r) => r.innerText.includes(${JSON.stringify(SESSION.accounts.approver.displayName)}) && r.dataset.assigned === "no")`);
  await T.click(`[...document.querySelectorAll('[data-testid="approver-row"]')].find((r) => r.innerText.includes(${JSON.stringify(SESSION.accounts.approver.displayName)})).querySelector('[data-testid="approver-grant"]')`);
  await T.waitFor(`[...document.querySelectorAll('[data-testid="approver-row"]')].some((r) => r.innerText.includes(${JSON.stringify(SESSION.accounts.approver.displayName)}) && r.dataset.assigned === "yes")`);
  check("owner: removed and re-assigned the approver on the request page", true);

  await signInBrowser(PORT, BASE, APPROVER);
  await T.goto(a.approvalUrl, reactReady('[data-testid="approve"]'));
  check(
    "after remove → re-assign: the old approval is No longer valid ('removed the approver … does not restore it'); none Active",
    (await T.evaluate(`document.querySelector('[data-approval="${first}"]')?.dataset.state`)) === "INVALIDATED" &&
      (await T.evaluate(`document.querySelector('[data-approval="${first}"] [data-testid="validity-reasons"]')?.innerText.includes("removed the approver")`)) &&
      !(await T.evaluate(`!!document.querySelector('[data-approval][data-state="ACTIVE"]')`)),
  );
  // Re-approve with the status read-back failing once: "saved, refresh failed", nothing posted again.
  await T.evaluate(`(() => { const real = window.fetch; window.__realFetch = real; window.fetch = (u, o) => (String(u).includes("/approvals/ap_") &&!(o && o.method) ? Promise.reject(new TypeError("simulated")) : real(u, o)); return true; })()`);
  mark = T.requests.length;
  const n1 = counts().approvals;
  await T.click(sel('[data-testid="approve"]'));
  await T.waitFor(`!!${sel('[data-testid="approve-refresh-failed"]')}`);
  check(
    "status read-back failing: 'Approval saved; refreshing its status failed', not 'not approved'; no button; one POST; one new row",
    (await T.evaluate(text('[data-testid="approve-result"]'))).includes("Approval saved; refreshing its status failed") && !(await T.evaluate(text('[data-testid="approve-result"]'))).includes("Not approved") && !(await T.evaluate(`!!${sel('[data-testid="approve"]')}`)) && writes(T, mark).filter((r) => r.endsWith("/approvals")).length === 1 && counts().approvals === n1 + 1,
  );
  await T.shot("31-usab-03a-saved-refresh-failed");
  await T.evaluate("(() => { window.fetch = window.__realFetch; return true; })()");
  await T.click(sel('[data-testid="approve-recheck"]'));
  await T.waitFor(`!!${sel('[data-testid="approved-active"]')}`);
  check("'Check status again' reads the state (GET only) → Approved — Active; still no second POST", writes(T, mark).filter((r) => r.endsWith("/approvals")).length === 1 && counts().approvals === n1 + 1);
  const second = await T.evaluate(`document.querySelector('[data-approval][data-state="ACTIVE"]').dataset.approval`);
  check("approving again → a NEW Active approval; the old one stays No longer valid", second !== first && (await T.evaluate(`document.querySelector('[data-approval="${first}"]').dataset.state`)) === "INVALIDATED");
  const ap = rows("SELECT id, approver_grant_seq AS seq FROM approvals WHERE request_id = ? ORDER BY rowid", a.requestId);
  const gr = rows("SELECT seq, action FROM approver_grants WHERE request_id = ? AND approver_id = ? ORDER BY seq", a.requestId, approverId);
  const actions = gr.map((g) => g.action).join(",");
  check(
    "DB: grants GRANT,REVOKE,GRANT in sequence; old approval names the first GRANT, new one the second (sequence, not clock)",
    actions === "GRANT,REVOKE,GRANT" && ap.length === 2 && ap[0].seq === gr[0].seq && ap[1].seq === gr[2].seq && gr[1].seq > ap[0].seq,
    `${actions}; approvals → seq ${ap.map((x) => x.seq).join(",")}`,
  );
  await T.shot("31-usab-03-v17-reapproved");
  await signInBrowser(PORT, BASE, SESSION);
  await T.goto(a.approvalUrl, `!!${sel('[data-testid="approved-active"]')}`);
  check("owner: sees 'Approved — Active' and the history (both approvals), never an Approve button", (await T.evaluate(`${sel('[data-testid="approved-active"]')}.dataset.activeApproval`)) === second && !(await T.evaluate(`!!${sel('[data-testid="approve"]')}`)) && (await T.evaluate(`document.querySelectorAll('[data-approval][data-state]').length`)) >= 2);

  // ---------- 1c. a newer version: no silent switch; version without a run ----------
  await signInBrowser(PORT, BASE, SESSION);
  const rev = rows("SELECT revision FROM procurement_requests WHERE id = ?", a.requestId)[0].revision;
  const v2 = await authedFetch(BASE, SESSION, `/api/procurements/${a.requestId}/quotes/${a.seriesId}/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), expectedRequestRevision: rev, expectedLatestVersionId: a.versionId, rawText: "[TEST] e2e usability — version 2, no extraction run (SYNTHETIC)", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "[TEST] (SYNTHETIC)", supplierQuoteDate: null, revisionNote: null }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const v2id = v2.body?.version?.id;
  check("saved quote version 2 (no extraction run)", v2.status === 201 && !!v2id, String(v2.status));
  mark = T.requests.length;
  await T.goto(quotesUrl, `!!document.querySelector('${ENTRY}[data-state="preview"]')`);
  const v1Href = await T.evaluate(`${sel('[data-testid="entry-status-link"]')}.getAttribute("href")`);
  check("v1 selected while v2 exists: entry stays on v1 and says v2 was saved since (not switched)", query(v1Href).version === a.versionId && (await T.evaluate(`${text(ENTRY)}.includes("Version 2 was saved later. Everything here is about version 1 only.")`)), v1Href);
  await T.click(`[...document.querySelectorAll('[role="tab"][data-version]')].find((b) => b.dataset.version === "2")`);
  await T.waitFor(`!!document.querySelector('${ENTRY}[data-state="no-run"]')`);
  check(
    "v2 (no run): no preview link; reason 'No extraction run is stored'; history link names v2 and no run",
    !(await T.evaluate(`!!${sel('[data-testid="entry-status-link"]')}`)) &&
      (await T.evaluate(`${text(ENTRY)}.includes("No extraction run is stored for this version")`)) &&
      JSON.stringify(query(await T.evaluate(`${sel('[data-testid="entry-history-link"]')}.getAttribute("href")`))) === JSON.stringify({ series: a.seriesId, version: v2id }),
  );
  await T.shot("31-usab-04-v2-no-run");
  await T.click(sel('[data-testid="entry-history-link"]'));
  await T.waitFor(`location.pathname.endsWith("/quotes/approval") && !!${sel('[data-testid="approval-no-run"]')}`);
  check("history link: approval page for v2 shows 'no run' + the history, no run chosen for it", !("run" in query(await T.evaluate("location.href"))) && (await T.evaluate(`!!${sel('[data-testid="approval-history"]')}`)));
  await T.goto(`${BASE}${v1Href}`, `!!${sel('[data-testid="approval-status"]')}`);
  check("v1 preview after v2: BLOCKED with NOT_LATEST_VERSION (the page does not switch versions)", (await T.evaluate(`[...document.querySelectorAll('[data-testid="block-list"] li')].some((e) => e.dataset.code === "NOT_LATEST_VERSION")`)) && query(await T.evaluate("location.href")).version === a.versionId);
  check("version / entry checks wrote nothing", writes(T, mark).length === 0, writes(T, mark).join(" | "));

  // ---------- 3. question card → supplier reply form ----------
  const draftUrl = `${BASE}/procurements/${rec.requestId}/quotes/drafts/${rec.draftId}`;
  const draftRef = `CD-${rec.draftId.replace(/^cd_/, "").slice(0, 8).toUpperCase()}`;
  const card = (i) => `document.querySelectorAll('[data-question][data-template]')[${i}]`;
  const states = `[...document.querySelectorAll('[data-testid="reply-question"]')].map((e) => e.dataset.state).join()`;
  await T.goto(draftUrl, `${reactReady('[data-testid="replies"]')} && ${reactReady('[data-testid="save-draft"]')}`);
  check(
    "labels: 'Save clarification draft' (sticky) and 'Save supplier reply' (reply form)",
    (await T.evaluate(text('[data-testid="save-draft"]'))) === "Save clarification draft" && (await T.evaluate(text('[data-testid="reply-save"]'))) === "Save supplier reply",
  );
  const c0 = counts();
  const s0 = await T.evaluate(states);
  mark = T.requests.length;
  const q2 = rec.questions[1];
  await T.click(`${card(1)}.querySelector('[data-testid="to-reply-form"]')`);
  await T.waitFor(`${sel('[data-testid="reply-form-pointer"]')}?.dataset.question === ${JSON.stringify(q2.id)}`);
  await sleep(300);
  check("pointer from Q2: reply text field focused and on screen", await T.evaluate(`(() => { const e = ${sel('[data-testid="reply-raw"]')}; const r = e.getBoundingClientRect(); return document.activeElement === e && r.top >= 0 && r.bottom <= innerHeight; })()`));
  check(
    "pointer shows the draft reference and Q2; says saving a reply does not answer Q2; no 'unsaved draft' note",
    (await T.evaluate(text('[data-testid="reply-form-draft"]'))).includes(draftRef) && (await T.evaluate(text('[data-testid="reply-form-pointer"]'))).includes("Opened from Q2") && (await T.evaluate(text('[data-testid="reply-form-pointer"]'))).includes("does not answer Q2") && !(await T.evaluate(`!!${sel('[data-testid="reply-form-draft-unsaved"]')}`)),
  );
  check("pointer wrote nothing; no question state changed; 'link to this draft' still as it was (ticked)", writes(T, mark).length === 0 && JSON.stringify(counts()) === JSON.stringify(c0) && (await T.evaluate(states)) === s0 && (await T.evaluate(`${sel('[data-testid="reply-link-after"]')}.checked`)));
  await T.shot("31-usab-05-pointer-q2");
  // With unsaved draft edits: the note says they stay unsaved.
  await T.setText(`${card(0)}.querySelector('[data-testid="text-en"]')`, `${await T.evaluate(`${card(0)}.querySelector('[data-testid="text-en"]').value`)} (edited)`);
  await T.waitFor(`${text('[data-testid="draft-save-state"]')}.includes("Unsaved")`);
  await T.click(`${card(0)}.querySelector('[data-testid="to-reply-form"]')`);
  await T.waitFor(`${sel('[data-testid="reply-form-pointer"]')}?.dataset.question === ${JSON.stringify(rec.questions[0].id)}`);
  check("pointer from Q1 with unsaved draft edits: note shown, draft still unsaved, nothing written", (await T.evaluate(`!!${sel('[data-testid="reply-form-draft-unsaved"]')}`)) && (await T.evaluate(`${text('[data-testid="draft-save-state"]')}.includes("Unsaved")`)) && JSON.stringify(counts()) === JSON.stringify(c0));

  // ---------- 4. save notices ----------
  await T.click(sel('[data-testid="save-draft"]'));
  await T.waitFor(`${text('[data-testid="draft-notice"]')}.includes("Clarification draft saved — revision 2")`);
  await T.click(sel('[data-testid="save-draft"]'));
  await T.waitFor(`${text('[data-testid="draft-notice"]')}.includes("Clarification draft: no changes to save (still revision 2)")`);
  check("draft: success and no-change notices name the clarification draft; one revision written", counts().draftRevisions === c0.draftRevisions + 1 && counts().replies === c0.replies);
  // Conflict: revision 3 saved elsewhere (API, same buyer), then a save from this page with revision 2.
  const cur = await authedFetch(BASE, SESSION, `/api/procurements/${rec.requestId}/clarification-drafts/${rec.draftId}`).then((r) => r.json());
  const content = cur.latest?.content ?? cur.draft?.latest?.content;
  const put = await authedFetch(BASE, SESSION, `/api/procurements/${rec.requestId}/clarification-drafts/${rec.draftId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ saveKey: crypto.randomUUID(), expectedRevision: 2, content: { ...content, en: { ...content.en, closing: `${content.en.closing} (other tab)` } } }),
  });
  await T.setText(`${card(0)}.querySelector('[data-testid="text-en"]')`, `${await T.evaluate(`${card(0)}.querySelector('[data-testid="text-en"]').value`)} again`);
  await T.click(sel('[data-testid="save-draft"]'));
  await T.waitFor(`!!${sel('[data-testid="draft-conflict"]')}`);
  check("draft conflict still detected: 'Clarification draft not saved: … saved elsewhere'; nothing overwritten", put.status === 200 && (await T.evaluate(text('[data-testid="draft-notice"]'))).startsWith("Clarification draft not saved: this draft was saved elsewhere") && counts().draftRevisions === c0.draftRevisions + 2, String(put.status));
  // Failure (server unreachable, simulated in this page only). 8 Nov (owner rule): the page cannot know whether a failed
  // write reached the server, so it must not claim "not saved" — it shows the neutral message; the DB proves nothing was
  // stored here (the simulated failure never reaches the server). (Until 8 Nov this asserted "… not saved:".)
  const NEUTRAL = "We couldn't confirm the result. Your change may have been saved. Check the current status (for example in a new tab — your text here is kept) before trying again.";
  await T.evaluate(`(() => { window.__fetch = window.fetch; window.fetch = (u, o) => (o && o.method && o.method !== "GET" ? Promise.reject(new TypeError("offline (e2e)")) : window.__fetch(u, o)); return true; })()`);
  await T.click(sel('[data-testid="save-draft"]'));
  await T.waitFor(`${text('[data-testid="draft-notice"]')} === ${JSON.stringify(NEUTRAL)}`);
  await T.setText(sel('[data-testid="reply-raw"]'), "[TEST] e2e usability reply (SYNTHETIC): we confirm the quantity.");
  await T.waitFor(`!${sel('[data-testid="reply-save"]')}.disabled`);
  await T.click(sel('[data-testid="reply-save"]'));
  await T.waitFor(`${text('[data-testid="reply-notice"]')} === ${JSON.stringify(NEUTRAL)}`);
  check("unconfirmed writes (offline): neutral 'couldn't confirm … your text here is kept' for draft and reply, no 'not saved' claim; nothing stored", counts().replies === c0.replies && counts().draftRevisions === c0.draftRevisions + 2 && !/not saved/i.test(await T.evaluate(text('[data-testid="draft-notice"]')) + await T.evaluate(text('[data-testid="reply-notice"]'))));
  await T.evaluate(`(() => { window.fetch = window.__fetch; return true; })()`);
  const s1 = await T.evaluate(states);
  await T.click(sel('[data-testid="reply-save"]'));
  await T.waitFor(`${text('[data-testid="reply-notice"]')}.startsWith("Supplier reply saved as received")`);
  await T.waitFor(`document.querySelectorAll('[data-testid="reply-card"]').length === 1`);
  check("reply: 'Supplier reply saved as received…' + linked; no question marked answered", counts().replies === c0.replies + 1 && counts().links === c0.links + 1 && counts().answers === c0.answers && (await T.evaluate(states)) === s1);
  await T.shot("31-usab-06-reply-saved");

  check("no console errors", T.errors.length === 0, T.errors.join(" | ").slice(0, 1000));
  const ext = external(T.requests);
  check("no request to any other host", ext.length === 0, ext.join(" | ").slice(0, 300));
  const after = counts();
  check("ledger, LIVE runs, MOCK runs, payments, payment events, approval payments unchanged since seeding", ["ledger", "settled", "live", "mock", "payments", "paymentEvents", "approvalPayments"].every((k) => after[k] === afterSeed[k]), JSON.stringify(after));
} catch (err) {
  check("e2e run", false, err.message);
} finally {
  T?.close();
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
