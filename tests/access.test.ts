// Sign-in and object-level access (30 Oct, schema v15; docs/access-control.md). Temporary databases only; REAL
// accounts (random per-run passwords held in memory), REAL login through the HTTP handler, REAL session cookies and
// CSRF tokens, the REAL AuthStore lookup behind policy.ts, and the real HTTP handlers. SYNTHETIC records (MOCK
// extraction replay, no model) and MOCK PayPal (no network).
//
// Covers: signed-out access; Buyer A / Buyer B isolation of lists, search counts, detail, history, quotes, versions,
// runs, reviews, comparison, drafts, replies, approvals, approvers; guessed and mixed ids; forged owner / actor fields;
// approver unassigned / assigned / revoked / re-assigned; buyer cannot approve, approver cannot pay or change the
// basis; session expiry, logout, login replacing an old session, CSRF; legacy local approvals cannot pay; old demo
// disabled; audit without secrets; migration v14 → v15 on a copy.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { canReadRequest, type Principal } from "../src/server/access/policy.ts";
import { readRecordFor } from "../src/server/access/record-context.ts";
import { handleApprove, handlePaymentStep, handlePreview, handleRevoke, handleView } from "../src/server/approval/http.ts";
import { APPROVAL_V17_TRIGGER } from "../src/server/approval/schema-sql.ts";
import { ApprovalService } from "../src/server/approval/service.ts";
import { ApprovalStore } from "../src/server/approval/store.ts";
import type { GuardOptions } from "../src/server/auth/gate.ts";
import { handleApprovers, handleLogin, handleLogout } from "../src/server/auth/http.ts";
import { hashPassword, verifyPassword } from "../src/server/auth/password.ts";
import { AuthService, CSRF_HEADER, SESSION_IDLE_MS } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { handleListDrafts, handleGetDraft } from "../src/server/clarification/http.ts";
import { ClarificationService } from "../src/server/clarification/service.ts";
import { ClarificationStore } from "../src/server/clarification/store.ts";
import { handleComparison } from "../src/server/comparison/http.ts";
import { ComparisonService } from "../src/server/comparison/service.ts";
import { SCHEMA_VERSION } from "../src/server/db/database.ts";
import { handleListExtractions } from "../src/server/extraction/http.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { sandboxDemoEnabled } from "../src/server/payments/demo-switch.ts";
import { handleCreate, handleGet, handleList, handleListRevisions, handleUpdate } from "../src/server/procurement/http.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { handleAddVersion, handleGetVersion, handleListQuotes } from "../src/server/quotes/http.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { handleGetReplies } from "../src/server/replies/http.ts";
import { ReplyService } from "../src/server/replies/service.ts";
import { ReplyStore } from "../src/server/replies/store.ts";
import { handleSearch } from "../src/server/search/http.ts";
import { SearchStore } from "../src/server/search/store.ts";
import { replayModel, replayService, reviewAll, seedCase, type Seeded } from "./helpers/approval-fixtures.ts";
import { MOCK_PAYEE, MockPayPal } from "./mock-paypal.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-access-test-"));
});
after(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const HOST = "127.0.0.1:3000";
const BASE = `http://${HOST}`;
type Session = { cookie: string; csrf: string; principal: Principal };

async function world() {
  const path = join(dir, `access-${++counter}.sqlite`);
  const clock = { now: new Date("2026-10-31T02:00:00Z") };
  const authStore = new AuthStore(path, { now: () => clock.now });
  const auth = new AuthService(authStore, { now: () => clock.now });
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const cs = new ClarificationStore(path);
  const rs = new ReplyStore(path);
  // Same clock as the auth store: approval validity compares the approval time with grant / revoke times (31 Oct: with
  // the real clock here, approvals made after 2026-10-31T02:00Z looked newer than the fixed-clock revoke row).
  const aps = new ApprovalStore(path, { now: () => clock.now });
  const pay = new PaymentStore(path);
  const search = new SearchStore(path);
  open.push(authStore, ps, qs, es, cs, rs, aps, pay, search);
  const model = replayModel();
  const svc = replayService(es, model);
  const comparison = new ComparisonService(es, { now: () => clock.now });
  const clar = new ClarificationService(cs, comparison);
  const replies = new ReplyService(rs, cs);
  const paypal = new MockPayPal();
  const payments = new PaymentService({ store: pay, gateway: paypal, payeeMerchantId: MOCK_PAYEE });
  const approvals = new ApprovalService({
    store: aps,
    extraction: es,
    procurement: ps,
    replies,
    replyStore: rs,
    drafts: cs,
    payments: () => payments,
    payee: () => ({ configured: true, merchantId: MOCK_PAYEE }),
    now: () => clock.now,
    accountName: (id) => authStore.account(id)?.displayName ?? null,
  });
  // Random per-run test passwords, never written anywhere.
  const pw = { "buyer-a": randomBytes(12).toString("base64url"), "buyer-b": randomBytes(12).toString("base64url"), approver: randomBytes(12).toString("base64url") };
  await auth.createAccount("buyer-a", "BUYER", "Buyer A", pw["buyer-a"]);
  await auth.createAccount("buyer-b", "BUYER", "Buyer B", pw["buyer-b"]);
  await auth.createAccount("approver", "APPROVER", "Approver", pw.approver);
  const opts: GuardOptions = { enabled: true, auth };
  const w = { path, clock, authStore, auth, ps, qs, es, cs, rs, aps, pay, search, model, svc, comparison, clar, replies, paypal, payments, approvals, pw, opts };

  async function login(username: keyof typeof pw, existingCookie?: string): Promise<Session> {
    const res = await handleLogin(req("POST", "/api/auth/login", { username, password: pw[username] }, existingCookie ? { cookie: existingCookie } : {}), auth, { enabled: true });
    assert.equal(res.status, 200, `login ${username}`);
    const set = res.headers.getSetCookie();
    const value = (name: string) => set.find((c) => c.startsWith(`${name}=`))!.split(";")[0].slice(name.length + 1);
    const cookie = `tp_session=${value("tp_session")}; tp_csrf=${value("tp_csrf")}`;
    return { cookie, csrf: value("tp_csrf"), principal: auth.resolve(value("tp_session"))! };
  }
  /** A buyer's SYNTHETIC record, created through the services as that buyer (owner row in the creating transaction). */
  async function recordOf(s: Session, label: string): Promise<Seeded> {
    const seeded = await seedCase(w, "A", label, { principal: s.principal, ownerId: s.principal.id });
    reviewAll(w, seeded, { principal: s.principal });
    return seeded;
  }
  return { ...w, login, recordOf };
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { host: HOST, ...(method === "GET" ? {} : { origin: BASE, "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const as = (s: Session | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  req(method, path, body, { ...(s ? { cookie: s.cookie } : {}), ...(s && method !== "GET" ? { [CSRF_HEADER]: s.csrf } : {}), "idempotency-key": randomUUID(), ...extra });

const count = (path: string, table: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
};
const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("sign-in and sessions", () => {
  test("passwords: scrypt hash string, constant-time verify; accounts are never overwritten; short / empty passwords create nothing; rows are immutable", async () => {
    const h = await hashPassword("correct horse battery");
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.ok(await verifyPassword("correct horse battery", h));
    assert.ok(!(await verifyPassword("correct horse batterY", h)));
    const w = await world();
    const before = w.authStore.accountByUsername("buyer-a")!.passwordHash;
    assert.equal(await w.auth.createAccount("buyer-a", "BUYER", "Buyer A", "another-password-123"), "EXISTS");
    assert.equal(w.authStore.accountByUsername("buyer-a")!.passwordHash, before, "existing account not overwritten");
    await assert.rejects(w.auth.createAccount("buyer-c", "BUYER", "Buyer C", ""), /at least 12/);
    await assert.rejects(w.auth.createAccount("buyer-c", "BUYER", "Buyer C", "short"), /at least 12/);
    assert.equal(w.authStore.accountByUsername("buyer-c"), null);
    const raw = new DatabaseSync(w.path);
    // v16: only the local reset script changes a password hash; every other column stays fixed.
    assert.throws(() => raw.exec("UPDATE principals SET username = 'buyer-x' WHERE username = 'buyer-a'"), /only the password hash/);
    assert.throws(() => raw.exec("DELETE FROM principals"), /cannot be deleted/);
    raw.close();
  });

  test("login: one answer for unknown user and wrong password; lockout after 5 failures (also for unknown names); cookies HttpOnly + SameSite=Strict, Secure only over HTTPS; no secret in the audit", async () => {
    const w = await world();
    const bad = await handleLogin(req("POST", "/api/auth/login", { username: "buyer-a", password: "wrong-password-1" }), w.auth, { enabled: true });
    const unknown = await handleLogin(req("POST", "/api/auth/login", { username: "nobody", password: "wrong-password-1" }), w.auth, { enabled: true });
    assert.deepEqual([bad.status, unknown.status], [401, 401]);
    assert.deepEqual(await bodyOf(bad), await bodyOf(unknown), "same message: no account enumeration");
    assert.equal((await handleLogin(req("POST", "/api/auth/login", { username: "buyer-a", password: w.pw["buyer-a"], role: "APPROVER" }), w.auth, { enabled: true })).status, 422, "no extra fields");
    for (let i = 0; i < 4; i++) await handleLogin(req("POST", "/api/auth/login", { username: "nobody", password: "x" }), w.auth, { enabled: true });
    assert.equal((await handleLogin(req("POST", "/api/auth/login", { username: "nobody", password: "x" }), w.auth, { enabled: true })).status, 429);
    for (let i = 0; i < 5; i++) await handleLogin(req("POST", "/api/auth/login", { username: "buyer-b", password: "nope" }), w.auth, { enabled: true });
    const locked = await handleLogin(req("POST", "/api/auth/login", { username: "buyer-b", password: w.pw["buyer-b"] }), w.auth, { enabled: true });
    assert.equal(locked.status, 429, "the right password does not pass while locked");
    w.clock.now = new Date(w.clock.now.getTime() + 16 * 60 * 1000);
    const ok = await handleLogin(req("POST", "/api/auth/login", { username: "buyer-a", password: w.pw["buyer-a"] }), w.auth, { enabled: true });
    assert.equal(ok.status, 200);
    const cookies = ok.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("tp_session="))!;
    assert.match(session, /; Path=\//);
    assert.match(session, /; HttpOnly/);
    assert.match(session, /; SameSite=Strict/);
    assert.doesNotMatch(session, /Secure/, "local http: Secure cookies would be dropped by the browser");
    assert.doesNotMatch(cookies.find((c) => c.startsWith("tp_csrf="))!, /HttpOnly/, "the page must read the CSRF token");
    const secure = await handleLogin(new Request("https://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { host: HOST, origin: "https://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify({ username: "buyer-a", password: w.pw["buyer-a"] }) }), w.auth, { enabled: true });
    assert.ok(secure.headers.getSetCookie().every((c) => /; Secure/.test(c)), "HTTPS → Secure");
    const token = session.split(";")[0].slice("tp_session=".length);
    const db = new DatabaseSync(w.path, { readOnly: true });
    const audit = JSON.stringify(db.prepare("SELECT * FROM access_audit").all());
    const sessions = JSON.stringify(db.prepare("SELECT * FROM sessions").all());
    db.close();
    for (const secret of [w.pw["buyer-a"], w.pw["buyer-b"], token, "wrong-password-1"]) {
      assert.ok(!audit.includes(secret) && !sessions.includes(secret), "no password or token stored in clear");
    }
    assert.ok(!audit.includes('"nobody"'), "attempted names are stored only as a hash");
  });

  test("sessions: signed out → 401; logout revokes on the server (old cookie dead); a new login revokes the session the browser presented; idle and absolute expiry", async () => {
    const w = await world();
    assert.equal((await handleList(req("GET", "/api/procurements"), w.ps, w.opts)).status, 401);
    assert.equal((await handleList(req("GET", "/api/procurements", undefined, { cookie: "tp_session=forged" }), w.ps, w.opts)).status, 401);
    const a = await w.login("buyer-a");
    assert.equal((await handleList(as(a, "GET", "/api/procurements"), w.ps, w.opts)).status, 200);
    assert.equal((await handleLogout(as(a, "POST", "/api/auth/logout"), w.auth, w.opts)).status, 200);
    assert.equal((await handleList(as(a, "GET", "/api/procurements"), w.ps, w.opts)).status, 401, "old cookie no longer works");
    const a1 = await w.login("buyer-a");
    const a2 = await w.login("buyer-a", a1.cookie);
    assert.equal((await handleList(as(a1, "GET", "/api/procurements"), w.ps, w.opts)).status, 401, "the presented session was replaced");
    assert.equal((await handleList(as(a2, "GET", "/api/procurements"), w.ps, w.opts)).status, 200);
    w.clock.now = new Date(w.clock.now.getTime() + SESSION_IDLE_MS + 1000);
    assert.equal((await handleList(as(a2, "GET", "/api/procurements"), w.ps, w.opts)).status, 401, "idle expiry");
    const a3 = await w.login("buyer-a");
    for (let i = 0; i < 9; i++) {
      w.clock.now = new Date(w.clock.now.getTime() + 55 * 60 * 1000); // active, but past the 8 h absolute limit eventually
      await handleList(as(a3, "GET", "/api/procurements"), w.ps, w.opts);
    }
    assert.equal((await handleList(as(a3, "GET", "/api/procurements"), w.ps, w.opts)).status, 401, "absolute expiry");
  });

  test("CSRF: a state-changing request without or with a wrong token is refused and writes nothing; Origin is checked separately", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const input = { buyerType: "BUSINESS", buyerCompany: "Test Co (SYNTHETIC)", title: "[TEST] csrf (SYNTHETIC)", items: [{ id: null, name: "Item", quantity: "1", unit: "pcs", material: "", specification: "", customization: "", notes: "" }] };
    const none = await handleCreate(req("POST", "/api/procurements", input, { cookie: a.cookie }), w.ps, w.opts);
    const wrong = await handleCreate(req("POST", "/api/procurements", input, { cookie: a.cookie, [CSRF_HEADER]: "x".repeat(43) }), w.ps, w.opts);
    const other = await w.login("buyer-b");
    const foreignToken = await handleCreate(req("POST", "/api/procurements", input, { cookie: a.cookie, [CSRF_HEADER]: other.csrf }), w.ps, w.opts);
    assert.deepEqual([none.status, wrong.status, foreignToken.status], [403, 403, 403]);
    const crossSite = await handleCreate(req("POST", "/api/procurements", input, { cookie: a.cookie, [CSRF_HEADER]: a.csrf, origin: "http://evil.example" }), w.ps, w.opts);
    assert.equal(crossSite.status, 403);
    assert.equal(count(w.path, "procurement_requests"), 0);
    assert.equal((await handleCreate(as(a, "POST", "/api/procurements", input), w.ps, w.opts)).status, 201);
  });
});

describe("object-level access: Buyer A / Buyer B", () => {
  test("lists, search counts, detail, history, quotes, versions, runs, comparison, drafts, replies, approvals, approvers: B sees nothing of A — the same 404 as a missing id", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const b = await w.login("buyer-b");
    const ra = await w.recordOf(a, "Alpha-only 7781");
    const draft = w.clar.create(a.principal, ra.request.id, ra.seriesId, ra.versionId, ra.run.id, null, null);
    const draftId = (draft as { draft?: { id: string } }).draft?.id;
    const rb = await w.recordOf(b, "Bravo-only 9932");

    const listB = (await bodyOf(await handleList(as(b, "GET", "/api/procurements"), w.ps, w.opts))).requests as { id: string }[];
    assert.deepEqual(listB.map((r) => r.id), [rb.request.id]);
    const searchB = await bodyOf(await handleSearch(as(b, "GET", "/api/procurements/search?q=7781"), w.search, w.opts));
    assert.deepEqual([(searchB.hits as unknown[]).length, searchB.total, searchB.totalRequests], [0, 0, 0], "scope applied before matching and counting");
    const searchA = await bodyOf(await handleSearch(as(a, "GET", "/api/procurements/search?q=7781"), w.search, w.opts));
    const hitsA = searchA.hits as { request: { id: string } }[];
    assert.ok(hitsA.length >= 1 && hitsA.every((h) => h.request.id === ra.request.id), "A finds only its own request (title and quote name)");

    const missing = `pr_${randomUUID()}`;
    const r = ra.request.id;
    const q = `series=${ra.seriesId}&version=${ra.versionId}&run=${ra.run.id}`;
    const probes: [string, (id: string) => Promise<Response>][] = [
      ["detail", (id) => handleGet(as(b, "GET", `/api/procurements/${id}`), id, w.ps, w.opts)],
      ["history", (id) => handleListRevisions(as(b, "GET", `/api/procurements/${id}/revisions`), id, w.ps, w.opts)],
      ["quotes", (id) => handleListQuotes(as(b, "GET", `/api/procurements/${id}/quotes`), id, w.qs, w.opts)],
      ["version + raw text", (id) => handleGetVersion(as(b, "GET", "/v"), id, ra.seriesId, ra.versionId, w.qs, w.opts)],
      ["runs + reviews", (id) => handleListExtractions(as(b, "GET", "/x"), id, ra.seriesId, ra.versionId, w.svc, w.opts)],
      ["comparison", (id) => handleComparison(as(b, "GET", `/c?run=${ra.run.id}`), id, ra.seriesId, ra.versionId, w.comparison, w.opts)],
      ["drafts", (id) => handleListDrafts(as(b, "GET", "/d"), id, ra.seriesId, ra.versionId, w.clar, w.opts)],
      ["approval preview", (id) => handlePreview(as(b, "GET", `/api/procurements/${id}/approvals?${q}`), id, w.approvals, w.opts)],
      ["approval list", (id) => handlePreview(as(b, "GET", `/api/procurements/${id}/approvals`), id, w.approvals, w.opts)],
      ["approvers", (id) => handleApprovers(as(b, "GET", `/api/procurements/${id}/approvers`), id, w.auth, w.opts)],
    ];
    if (draftId) {
      probes.push(["draft", (id) => handleGetDraft(as(b, "GET", "/d1"), id, draftId, w.clar, w.opts)]);
      probes.push(["replies", (id) => handleGetReplies(as(b, "GET", "/r1"), id, draftId, w.replies, w.opts)]);
    }
    for (const [name, call] of probes) {
      const own = await call(r);
      const none = await call(missing);
      assert.equal(own.status, 404, `${name}: B gets 404 on A's request`);
      assert.equal(none.status, 404, `${name}: missing id 404`);
      assert.deepEqual(await bodyOf(own), await bodyOf(none), `${name}: same body as a missing id`);
    }
    // Writes by B on A's record: refused, nothing written.
    const rows = ["procurement_request_revisions", "quote_versions", "quote_extraction_reviews", "supplier_replies", "approver_grants"].map((t) => count(w.path, t));
    assert.equal((await handleUpdate(as(b, "PUT", `/api/procurements/${r}`, { revision: 1 }), r, w.ps, w.opts)).status, 404);
    assert.equal((await handleAddVersion(as(b, "POST", "/q", {}), r, ra.seriesId, w.qs, w.opts)).status, 404);
    assert.equal(w.svc.review(b.principal, r, ra.seriesId, ra.versionId, ra.run.id, { idempotencyKey: randomUUID(), fieldPath: "total", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: null }).status, "NOT_FOUND");
    assert.equal(w.replies.saveReply(b.principal, r, ra.seriesId, { rawText: "[SYNTHETIC] hi", source: "TEST_FIXTURE" }, randomUUID()).status, "NOT_FOUND");
    assert.equal((await handleApprovers(as(b, "POST", `/api/procurements/${r}/approvers`, { approverId: w.authStore.accountByUsername("approver")!.id, action: "GRANT" }), r, w.auth, w.opts)).status, 404);
    assert.deepEqual(["procurement_request_revisions", "quote_versions", "quote_extraction_reviews", "supplier_replies", "approver_grants"].map((t) => count(w.path, t)), rows);
    // The Copilot entry gives nothing to B.
    assert.equal(readRecordFor(b.principal, r, { procurement: w.ps, quotes: w.qs }), null);
    assert.equal(readRecordFor(a.principal, r, { procurement: w.ps, quotes: w.qs })?.record.id, r);
  });

  test("mixed ids: B's own request id with A's series / version / run / draft / approval ids → 404; forged owner fields → 422; the creator is always the owner", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const b = await w.login("buyer-b");
    const ra = await w.recordOf(a, "A");
    const rb = await w.recordOf(b, "B");
    const ap = await w.login("approver");
    await handleApprovers(as(a, "POST", "/x", { approverId: ap.principal.id, action: "GRANT" }), ra.request.id, w.auth, w.opts);
    const e = (w.approvals.preview(ap.principal, ra.request.id, { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null }) as { evaluation: { digest: string; confirmKeys: string[] } }).evaluation;
    const approved = w.approvals.approve(ap.principal, ra.request.id, { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null, previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID());
    assert.equal(approved.status, "CREATED");
    const approvalId = (approved as { approval: { id: string } }).approval.id;
    const own = rb.request.id;
    assert.equal((await handleGetVersion(as(b, "GET", "/v"), own, ra.seriesId, ra.versionId, w.qs, w.opts)).status, 404);
    assert.equal((await handleGetVersion(as(b, "GET", "/v"), own, rb.seriesId, ra.versionId, w.qs, w.opts)).status, 404, "A's version under B's series");
    assert.equal((await handleComparison(as(b, "GET", `/c?run=${ra.run.id}`), own, rb.seriesId, rb.versionId, w.comparison, w.opts)).status, 404, "A's run on B's version");
    assert.equal((await handlePreview(as(b, "GET", `/p?series=${rb.seriesId}&version=${rb.versionId}&run=${ra.run.id}`), own, w.approvals, w.opts)).status, 404);
    assert.equal((await handleView(as(b, "GET", "/a"), own, approvalId, w.approvals, w.opts)).status, 404, "A's approval under B's request");
    assert.equal((await handlePaymentStep(as(b, "POST", "/p", {}), own, approvalId, "start", w.approvals, { ...w.opts, paymentsEnabled: true })).status, 404);
    assert.equal((await handleRevoke(as(b, "POST", "/r", { note: "x" }), own, approvalId, w.approvals, w.opts)).status, 404);
    assert.equal(w.svc.review(b.principal, own, rb.seriesId, rb.versionId, ra.run.id, { idempotencyKey: randomUUID(), fieldPath: "total", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: null }).status, "NOT_FOUND", "A's run under B's ids");
    // Forged owner / actor fields.
    const input = { buyerType: "BUSINESS", buyerCompany: "Test Co (SYNTHETIC)", title: "[TEST] forged (SYNTHETIC)", items: [{ id: null, name: "Item", quantity: "1", unit: "pcs", material: "", specification: "", customization: "", notes: "" }] };
    assert.equal((await handleCreate(as(b, "POST", "/api/procurements", { ...input, ownerId: a.principal.id }), w.ps, w.opts)).status, 422);
    assert.equal((await handleCreate(as(b, "POST", "/api/procurements", { ...input, owner: "buyer-a" }), w.ps, w.opts)).status, 422);
    const created = (await bodyOf(await handleCreate(as(b, "POST", "/api/procurements", input), w.ps, w.opts))).record as { id: string };
    assert.equal(w.authStore.ownerOf(created.id), b.principal.id);
    const approveBody = { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null, previewDigest: e.digest, confirmed: e.confirmKeys, actor: { kind: "APPROVER", id: "someone" } };
    assert.equal((await handleApprove(as(ap, "POST", "/a", approveBody), ra.request.id, w.approvals, w.opts)).status, 422, "actor is never taken from the client");
    assert.equal((await handleCreate(as(ap, "POST", "/api/procurements", input), w.ps, w.opts)).status, 403, "an approver creates nothing");
  });
});

describe("approver and buyer duties", () => {
  test("approver: unassigned → 404; assigned → reads and approves (recorded as that account), cannot change the basis or pay; revoke → next request 404 and the approval cannot pay; re-assign does not restore it", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const ap = await w.login("approver");
    const ra = await w.recordOf(a, "duties");
    const r = ra.request.id;
    const ids = { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null };
    const q = `series=${ra.seriesId}&version=${ra.versionId}&run=${ra.run.id}`;
    assert.equal((await handleGet(as(ap, "GET", `/p/${r}`), r, w.ps, w.opts)).status, 404, "not assigned yet");
    assert.equal((await handlePreview(as(ap, "GET", `/p?${q}`), r, w.approvals, w.opts)).status, 404);
    // Buyer cannot approve its own request.
    const preview = (await bodyOf(await handlePreview(as(a, "GET", `/p?${q}`), r, w.approvals, w.opts))).evaluation as { digest: string; confirmKeys: string[] };
    const buyerApprove = await handleApprove(as(a, "POST", "/a", { ...ids, previewDigest: preview.digest, confirmed: preview.confirmKeys }), r, w.approvals, w.opts);
    assert.equal(buyerApprove.status, 403);
    assert.equal(count(w.path, "approvals"), 0);
    // Assign.
    const grant = await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts);
    assert.equal(grant.status, 200);
    assert.equal((await handleGet(as(ap, "GET", `/p/${r}`), r, w.ps, w.opts)).status, 200);
    const listAp = (await bodyOf(await handleList(as(ap, "GET", "/api/procurements"), w.ps, w.opts))).requests as { id: string }[];
    assert.deepEqual(listAp.map((x) => x.id), [r]);
    // Approver cannot change the basis or pay.
    const before = ["procurement_request_revisions", "quote_versions", "quote_extraction_reviews", "supplier_replies", "requirement_classifications", "sandbox_payment_records"].map((t) => count(w.path, t));
    assert.equal((await handleUpdate(as(ap, "PUT", `/p/${r}`, { revision: 1 }), r, w.ps, w.opts)).status, 404);
    assert.equal((await handleAddVersion(as(ap, "POST", "/q", {}), r, ra.seriesId, w.qs, w.opts)).status, 404);
    assert.equal(w.svc.review(ap.principal, r, ra.seriesId, ra.versionId, ra.run.id, { idempotencyKey: randomUUID(), fieldPath: "total", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: null }).status, "NOT_FOUND");
    assert.equal(w.replies.saveReply(ap.principal, r, ra.seriesId, { rawText: "[SYNTHETIC] ok", source: "TEST_FIXTURE" }, randomUUID()).status, "NOT_FOUND");
    assert.equal(w.approvals.classify(ap.principal, r, ra.seriesId, ra.versionId, { subject: "ADDITIONAL_REQUIREMENTS", decision: "NOT_KEY", reason: "x" }, randomUUID()).status, "NOT_FOUND");
    assert.equal((await handleApprovers(as(ap, "POST", "/g", { approverId: ap.principal.id, action: "REVOKE" }), r, w.auth, w.opts)).status, 404, "an approver cannot change assignments");
    // Approve.
    const pre = (await bodyOf(await handlePreview(as(ap, "GET", `/p?${q}`), r, w.approvals, w.opts))).evaluation as { digest: string; confirmKeys: string[] };
    const ok = await handleApprove(as(ap, "POST", "/a", { ...ids, previewDigest: pre.digest, confirmed: pre.confirmKeys }), r, w.approvals, w.opts);
    assert.equal(ok.status, 201);
    const approval = (await bodyOf(ok)).approval as { id: string; actor: { kind: string; id: string; authenticated: boolean } };
    assert.deepEqual(approval.actor, { kind: "APPROVER", id: ap.principal.id, authenticated: true });
    const payOpts = { ...w.opts, paymentsEnabled: true };
    assert.equal((await handlePaymentStep(as(ap, "POST", "/p", {}), r, approval.id, "start", w.approvals, payOpts)).status, 404, "the approver cannot pay");
    assert.deepEqual(["procurement_request_revisions", "quote_versions", "quote_extraction_reviews", "supplier_replies", "requirement_classifications", "sandbox_payment_records"].map((t) => count(w.path, t)), before, "nothing written by the approver");
    // Owner starts the payment and creates the order (MOCK), then removes the approver before the capture.
    assert.equal((await handlePaymentStep(as(a, "POST", "/p", {}), r, approval.id, "start", w.approvals, payOpts)).status, 201);
    const order = await bodyOf(await handlePaymentStep(as(a, "POST", "/p", {}), r, approval.id, "order", w.approvals, payOpts));
    w.paypal.approve(order.orderId as string);
    w.clock.now = new Date(w.clock.now.getTime() + 1000);
    assert.equal((await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "REVOKE" }), r, w.auth, w.opts)).status, 200);
    assert.equal((await handleGet(as(ap, "GET", `/p/${r}`), r, w.ps, w.opts)).status, 404, "revoked: the next request is refused");
    const cap = await bodyOf(await handlePaymentStep(as(a, "POST", "/p", { orderId: order.orderId }), r, approval.id, "capture", w.approvals, payOpts));
    assert.equal(cap.code, "APPROVAL_INVALID");
    assert.equal(w.paypal.calls.capture.length, 0, "no capture request after the approver was removed");
    assert.deepEqual(w.approvals.view(a.principal, r, approval.id)!.validity.reasons, ["APPROVER_UNASSIGNED"]);
    // Re-assign: the old approval stays invalid; a new approval is needed.
    w.clock.now = new Date(w.clock.now.getTime() + 1000);
    await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts);
    assert.equal(w.approvals.view(a.principal, r, approval.id)!.validity.state, "INVALIDATED");
    assert.ok(canReadRequest(ap.principal, r));
    // Audit: grant, approve, revoke grant — with actor, object, outcome; no secret.
    const audit = w.authStore.auditFor("REQUEST", r).map((x) => `${x.action}:${x.outcome}:${x.actorId === a.principal.id ? "A" : x.actorId === ap.principal.id ? "AP" : "?"}`);
    for (const e of ["APPROVE:DENIED:A", "APPROVER_GRANTED:OK:A", "APPROVE:OK:AP", "APPROVER_REVOKED:OK:A"]) assert.ok(audit.includes(e), `${e} in ${audit.join(", ")}`);
  });

  test("owner revokes an approval: further payment refused (no refund implied); a revoked grant inside the approve transaction stops the approval", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const ap = await w.login("approver");
    const ra = await w.recordOf(a, "revoke");
    const r = ra.request.id;
    await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts);
    const ids = { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null };
    const e = (w.approvals.preview(ap.principal, r, ids) as { evaluation: { digest: string; confirmKeys: string[] } }).evaluation;
    // The grant is revoked by another connection between the entry check and the write transaction.
    const original = w.aps.transaction.bind(w.aps);
    let once = true;
    w.aps.transaction = ((fn: () => unknown) => {
      if (once) {
        once = false;
        const other = new AuthStore(w.path);
        other.insertGrant(r, ap.principal.id, "REVOKE", a.principal.id);
        other.close();
      }
      return original(fn as () => never);
    }) as typeof w.aps.transaction;
    assert.equal(w.approvals.approve(ap.principal, r, { ...ids, previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID()).status, "FORBIDDEN");
    assert.equal(count(w.path, "approvals"), 0);
    w.aps.transaction = original;
    await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts);
    const created = w.approvals.approve(ap.principal, r, { ...ids, previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID());
    assert.equal(created.status, "CREATED");
    const id = (created as { approval: { id: string } }).approval.id;
    assert.equal((await handleRevoke(as(a, "POST", "/r", { note: "stop this payment (test)" }), r, id, w.approvals, w.opts)).status, 200);
    const start = await handlePaymentStep(as(a, "POST", "/p", {}), r, id, "start", w.approvals, { ...w.opts, paymentsEnabled: true });
    assert.equal((await bodyOf(start)).code, "APPROVAL_INVALID");
    assert.equal(count(w.path, "sandbox_payment_records"), 0);
  });
});

describe("history, old entries, migration", () => {
  test("historical local-developer approvals stay as they are and can never pay; the old Sandbox demo is off; no anonymous principal passes the policy", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const ra = await w.recordOf(a, "legacy");
    const r = ra.request.id;
    const ap = await w.login("approver");
    await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts);
    const pv = w.approvals.preview(ap.principal, r, { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null });
    assert.equal(pv.status, "OK");
    const ev = (pv as Extract<typeof pv, { status: "OK" }>).evaluation;
    // A row exactly like the approvals written before 30 Oct (local developer, not authenticated).
    const legacy = w.aps.insertApproval({
      requestId: r,
      seriesId: ra.seriesId,
      versionId: ra.versionId,
      baseVersionId: null,
      runId: ra.run.id,
      baseRunId: null,
      requestRevision: 1,
      requestFingerprint: ev.snapshot.request.fingerprint,
      latestVersionNumber: 1,
      reviewsDigest: ev.snapshot.digests.reviews,
      statementsDigest: ev.snapshot.digests.statements,
      classificationsDigest: ev.snapshot.digests.classifications,
      payeeFingerprint: ev.snapshot.payee.fingerprint!,
      rules: (await import("../src/server/approval/evaluate.ts")).rulesKey(),
      amountMinor: ev.amount!.minor,
      currency: ev.amount!.currency,
      snapshot: ev.snapshot,
      previewDigest: ev.digest,
      confirmed: [],
      actor: { kind: "LOCAL_DEV", id: null, authenticated: false },
      approverGrantSeq: null,
      idempotencyKey: randomUUID(),
      fingerprint: "f".repeat(64),
    });
    assert.equal(w.approvals.view(a.principal, r, legacy.id)!.validity.state, "ACTIVE", "history kept, not invalidated by the migration");
    const start = await handlePaymentStep(as(a, "POST", "/p", {}), r, legacy.id, "start", w.approvals, { ...w.opts, paymentsEnabled: true });
    assert.equal(start.status, 409);
    assert.equal((await bodyOf(start)).code, "APPROVAL_NOT_PAYABLE");
    assert.equal(count(w.path, "sandbox_payment_records"), 0);
    assert.match(w.approvals.view(a.principal, r, legacy.id)!.actorLabel, /not signed in/);
    assert.equal(sandboxDemoEnabled(), false);
    const anonymous = { kind: "LOCAL_DEV" } as unknown as Principal;
    assert.equal(canReadRequest(anonymous, r), false, "an anonymous / local-developer object is denied, not trusted");
  });

  test("migration v14 → current (v18) on a copy: the access tables are new (v15) and stay empty, existing rows untouched, no owner for existing requests, no account created, backup first", async () => {
    const path = join(dir, `migrate-${++counter}.sqlite`);
    const ps = new ProcurementStore(path);
    open.push(ps);
    const qs = new QuoteStore(path);
    open.push(qs);
    const es = new ExtractionStore(path);
    open.push(es);
    const model = replayModel();
    const P0 = (await import("./helpers/principals.ts")).testBuyer();
    const s = await seedCase({ ps, qs, es, svc: replayService(es, model), model }, "A", "pre-v15", { principal: P0 });
    ps.close();
    qs.close();
    es.close();
    const raw = new DatabaseSync(path);
    const hash = (t: string) => JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    raw.exec("DROP TABLE access_audit; DROP TABLE approver_grants; DROP TABLE procurement_owners; DROP TABLE sessions; DROP TABLE principals; PRAGMA user_version = 14;");
    const before = ["procurement_requests", "quote_versions", "quote_extraction_runs", "sandbox_payment_records", "ai_budget_ledger", "approvals"].map(hash);
    raw.close();
    const backups: string[] = [];
    const again = new AuthStore(path, { onBackup: (f) => backups.push(f) });
    open.push(again);
    const check = new DatabaseSync(path, { readOnly: true });
    const h2 = (t: string) => JSON.stringify(check.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 18);
    assert.deepEqual(["procurement_requests", "quote_versions", "quote_extraction_runs", "sandbox_payment_records", "ai_budget_ledger", "approvals"].map(h2), before);
    for (const t of ["principals", "sessions", "procurement_owners", "approver_grants", "access_audit"]) assert.equal(Number((check.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n), 0, t);
    assert.equal(again.ownerOf(s.request.id), null, "existing requests get no owner");
    assert.equal((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal(check.prepare("PRAGMA foreign_key_check").all().length, 0);
    check.close();
    assert.match(backups[0] ?? "", /\.v14-before-v18\./);
  });
});

describe("local password reset (schema v16)", () => {
  test("reset changes only the hash, revokes every session of that account (not others), keeps id / role / ownership / grants / history, writes an audit row without the password", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const a2 = await w.login("buyer-a");
    const b = await w.login("buyer-b");
    const ap = await w.login("approver");
    const ra = await w.recordOf(a, "reset");
    await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), ra.request.id, w.auth, w.opts);
    const before = w.authStore.accountByUsername("buyer-a")!;
    const grantsBefore = JSON.stringify(w.authStore.grants(ra.request.id));
    const newPassword = randomBytes(15).toString("base64url");

    assert.deepEqual(await w.auth.resetPassword("buyer-a", "short"), { status: "TOO_SHORT" });
    assert.deepEqual(await w.auth.resetPassword("buyer-a", w.pw["buyer-a"]), { status: "SAME_AS_CURRENT" });
    assert.deepEqual(await w.auth.resetPassword("nobody", newPassword), { status: "NOT_FOUND" });
    assert.equal(w.authStore.accountByUsername("buyer-a")!.passwordHash, before.passwordHash, "refusals change nothing");
    assert.equal((await handleList(as(a, "GET", "/api/procurements"), w.ps, w.opts)).status, 200, "refusals revoke nothing");

    const out = await w.auth.resetPassword("buyer-a", newPassword);
    assert.deepEqual(out, { status: "RESET", revokedSessions: 2 });
    const after = w.authStore.accountByUsername("buyer-a")!;
    assert.deepEqual([after.id, after.username, after.role, after.displayName, after.createdAt], [before.id, before.username, before.role, before.displayName, before.createdAt]);
    assert.notEqual(after.passwordHash, before.passwordHash);
    assert.equal(w.authStore.ownerOf(ra.request.id), before.id, "ownership kept");
    assert.equal(JSON.stringify(w.authStore.grants(ra.request.id)), grantsBefore, "grants kept");
    for (const s of [a, a2]) assert.equal((await handleList(as(s, "GET", "/api/procurements"), w.ps, w.opts)).status, 401, "every session of the account revoked");
    assert.equal((await handleList(as(b, "GET", "/api/procurements"), w.ps, w.opts)).status, 200, "other accounts keep their sessions");
    assert.equal((await handleList(as(ap, "GET", "/api/procurements"), w.ps, w.opts)).status, 200);
    const oldLogin = await handleLogin(req("POST", "/api/auth/login", { username: "buyer-a", password: w.pw["buyer-a"] }), w.auth, { enabled: true });
    assert.equal(oldLogin.status, 401, "the old password no longer works");
    w.pw["buyer-a"] = newPassword;
    const fresh = await w.login("buyer-a");
    assert.deepEqual((((await bodyOf(await handleList(as(fresh, "GET", "/api/procurements"), w.ps, w.opts))).requests) as { id: string }[]).map((r) => r.id), [ra.request.id], "same records after the reset");

    const db = new DatabaseSync(w.path, { readOnly: true });
    const reasons = db.prepare("SELECT revoke_reason FROM sessions WHERE principal_id = ? AND revoke_reason IS NOT NULL").all(before.id).map((r) => (r as { revoke_reason: string }).revoke_reason);
    const auditRows = db.prepare("SELECT * FROM access_audit WHERE action = 'PASSWORD_RESET'").all() as { object_id: string; outcome: string; detail: string }[];
    const audit = JSON.stringify(auditRows);
    db.close();
    assert.deepEqual(reasons, ["PASSWORD_RESET", "PASSWORD_RESET"]);
    assert.equal(auditRows.length, 1);
    assert.deepEqual([auditRows[0].object_id, auditRows[0].outcome, JSON.parse(auditRows[0].detail)], [before.id, "OK", { revokedSessions: 2, by: "LOCAL_OPERATOR_SCRIPT" }]);
    assert.ok(!audit.includes(newPassword) && !audit.includes(after.passwordHash), "no password or hash in the audit");

    const raw = new DatabaseSync(w.path);
    assert.throws(() => raw.exec("UPDATE principals SET username = 'someone' WHERE username = 'buyer-a'"), /only the password hash/);
    assert.throws(() => raw.exec("UPDATE principals SET role = 'APPROVER' WHERE username = 'buyer-a'"), /only the password hash/);
    assert.throws(() => raw.exec("DELETE FROM principals WHERE username = 'buyer-a'"), /cannot be deleted/);
    raw.close();
  });

  test("migration v15 → current (v18) on a copy: sessions rebuilt with every row identical, accounts unchanged, triggers in place", async () => {
    const w = await world();
    await w.login("buyer-a");
    const s = await w.login("buyer-b");
    await handleLogout(as(s, "POST", "/api/auth/logout"), w.auth, w.opts);
    const raw = new DatabaseSync(w.path);
    const dump = (t: string) => JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = { sessions: dump("sessions"), principals: dump("principals"), audit: dump("access_audit") };
    // Back to the v15 shape (old trigger and CHECK), as the real file was before.
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("DROP TRIGGER principals_fixed_columns; CREATE TRIGGER principals_immutable BEFORE UPDATE ON principals BEGIN SELECT RAISE(ABORT, 'principals are immutable'); END;");
    raw.exec("PRAGMA user_version = 15");
    raw.close();
    const backups: string[] = [];
    const again = new AuthStore(w.path, { onBackup: (f) => backups.push(f) });
    open.push(again);
    const check = new DatabaseSync(w.path, { readOnly: true });
    const d2 = (t: string) => JSON.stringify(check.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
    assert.deepEqual({ sessions: d2("sessions"), principals: d2("principals"), audit: d2("access_audit") }, before);
    const triggers = check.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('principals', 'sessions') ORDER BY name").all().map((r) => (r as { name: string }).name);
    assert.deepEqual(triggers, ["principals_fixed_columns", "principals_no_delete", "sessions_fixed_columns", "sessions_no_delete", "sessions_revocation_final"]);
    assert.equal((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal(check.prepare("PRAGMA foreign_key_check").all().length, 0);
    check.close();
    assert.match(backups[0] ?? "", /\.v15-before-v18\./);
  });
});

describe("approval audit is atomic with the decision", () => {
  test("audit write fails inside approve: nothing is stored and the caller gets an error (never a false 'saved'); after the fault a retry with the same key creates ONE approval with ONE audit row; revoke behaves the same", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const ap = await w.login("approver");
    const ra = await w.recordOf(a, "audit-fault");
    const r = ra.request.id;
    await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts);
    const ids = { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null };
    const e = (w.approvals.preview(ap.principal, r, ids) as { evaluation: { digest: string; confirmKeys: string[] } }).evaluation;
    const body = { ...ids, previewDigest: e.digest, confirmed: e.confirmKeys };
    const key = randomUUID();
    const auditRows = (action: string) => count(w.path, `access_audit WHERE action = '${action}' AND object_id = '${r}'`);

    const original = w.aps.audit.bind(w.aps);
    w.aps.audit = () => {
      throw new Error("simulated audit write failure (disk full)");
    };
    assert.throws(() => w.approvals.approve(ap.principal, r, body, key), /simulated audit write failure/, "the approve call fails loudly");
    assert.equal(count(w.path, "approvals"), 0, "the approval was rolled back with its audit row");
    assert.equal(auditRows("APPROVE"), 0);
    // Over HTTP the same fault is a 5xx-type failure of the request — the page shows "not approved", which is true.
    await assert.rejects(handleApprove(as(ap, "POST", "/a", body, { "idempotency-key": key }), r, w.approvals, w.opts), /simulated audit write failure/);
    assert.equal(count(w.path, "approvals"), 0);

    w.aps.audit = original;
    const first = w.approvals.approve(ap.principal, r, body, key);
    const replay = w.approvals.approve(ap.principal, r, body, key);
    assert.deepEqual([first.status, replay.status], ["CREATED", "REPLAYED"], "idempotency kept: same key → one row");
    const id = (first as { approval: { id: string } }).approval.id;
    assert.equal(count(w.path, "approvals"), 1);
    assert.equal(auditRows("APPROVE"), 1, "exactly one audit row for the one approval");
    const db = new DatabaseSync(w.path, { readOnly: true });
    const row = db.prepare("SELECT actor_id, outcome, detail FROM access_audit WHERE action = 'APPROVE' AND object_id = ?").get(r) as { actor_id: string; outcome: string; detail: string };
    db.close();
    assert.deepEqual([row.actor_id, row.outcome, JSON.parse(row.detail).approval], [ap.principal.id, "OK", id]);

    // Revoke: same rule.
    w.aps.audit = () => {
      throw new Error("simulated audit write failure (disk full)");
    };
    const revokeKey = randomUUID();
    assert.throws(() => w.approvals.revoke(a.principal, r, id, "stop (test)", revokeKey), /simulated audit write failure/);
    assert.equal(count(w.path, "approval_events"), 0, "revoke rolled back with its audit row");
    w.aps.audit = original;
    assert.equal(w.approvals.revoke(a.principal, r, id, "stop (test)", revokeKey).status, "REVOKED");
    assert.deepEqual([count(w.path, "approval_events"), auditRows("APPROVAL_REVOKED")], [1, 1]);
  });

  test("a refusal that writes nothing still answers correctly when its audit row cannot be written, and the failure is logged (not silent)", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const ra = await w.recordOf(a, "audit-best-effort");
    const ids = { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null };
    const e = (w.approvals.preview(a.principal, ra.request.id, ids) as { evaluation: { digest: string; confirmKeys: string[] } }).evaluation;
    w.aps.audit = () => {
      throw new Error("simulated audit write failure");
    };
    const logged: string[] = [];
    const errorLog = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      const out = w.approvals.approve(a.principal, ra.request.id, { ...ids, previewDigest: e.digest, confirmed: e.confirmKeys }, randomUUID());
      assert.equal(out.status, "FORBIDDEN", "the buyer's refusal is still reported correctly");
    } finally {
      console.error = errorLog;
    }
    assert.equal(count(w.path, "approvals"), 0);
    assert.ok(logged.some((l) => l.includes("[audit] could not write APPROVE DENIED")), logged.join(" | "));
  });
});

// R-ACCESS-CLOCK (31 Oct): the removal of the approving approver must be ordered by the database (grant sequence),
// never by wall-clock times, and payment must re-read the current assignment inside its own transaction.
describe("approver removal is ordered by the database, not by the clock", () => {
  async function approvedCase(label: string) {
    const w = await world();
    const a = await w.login("buyer-a");
    const ap = await w.login("approver");
    const ra = await w.recordOf(a, label);
    const r = ra.request.id;
    assert.equal((await handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action: "GRANT" }), r, w.auth, w.opts)).status, 200);
    const approve = async () => {
      const ids = { seriesId: ra.seriesId, versionId: ra.versionId, runId: ra.run.id, baseRunId: null };
      const pre = (await bodyOf(await handlePreview(as(ap, "GET", `/p?series=${ra.seriesId}&version=${ra.versionId}&run=${ra.run.id}`), r, w.approvals, w.opts))).evaluation as { digest: string; confirmKeys: string[] };
      return handleApprove(as(ap, "POST", "/a", { ...ids, previewDigest: pre.digest, confirmed: pre.confirmKeys }), r, w.approvals, w.opts);
    };
    const created = await approve();
    assert.equal(created.status, 201);
    const approvalId = ((await bodyOf(created)).approval as { id: string }).id;
    const grant = (action: "GRANT" | "REVOKE") => handleApprovers(as(a, "POST", "/g", { approverId: ap.principal.id, action }), r, w.auth, w.opts);
    const payOpts = { ...w.opts, paymentsEnabled: true };
    const pay = async (step: "start" | "order" | "capture", id = approvalId, body: Record<string, unknown> = {}) => {
      const res = await handlePaymentStep(as(a, "POST", "/p", body), r, id, step, w.approvals, payOpts);
      return { status: res.status, body: await bodyOf(res) };
    };
    const paypalCalls = () => w.paypal.calls.create.length + w.paypal.calls.capture.length;
    return { w, a, ap, r, approvalId, approve, grant, pay, paypalCalls };
  }
  const back = (w: { clock: { now: Date } }, ms: number) => (w.clock.now = new Date(w.clock.now.getTime() - ms));

  test("clock stepped back after the approval, then the approver is removed: the old approval cannot start a payment (no event, no page view needed), no PayPal call", async () => {
    const c = await approvedCase("clock-back");
    back(c.w, 60 * 60 * 1000);
    assert.equal((await c.grant("REVOKE")).status, 200);
    assert.equal(count(c.w.path, "approval_events"), 0, "no INVALIDATED event exists before the payment attempt");
    const start = await c.pay("start");
    assert.equal(start.body.code, "APPROVAL_INVALID", JSON.stringify(start.body));
    assert.equal(count(c.w.path, "approval_payments"), 0);
    assert.equal(c.paypalCalls(), 0);
  });

  test("approval and removal with the same timestamp: removal wins", async () => {
    const c = await approvedCase("same-time");
    const approval = c.w.aps.approval(c.approvalId)!;
    c.w.clock.now = new Date(approval.createdAt);
    assert.equal((await c.grant("REVOKE")).status, 200);
    assert.equal((await c.pay("start")).body.code, "APPROVAL_INVALID");
    assert.equal(c.paypalCalls(), 0);
  });

  test("repeated assignment adds nothing; no cumulative limit on remove / re-assign; re-assigning never restores an approval made before a removal (2 Nov, owner decision: no cap)", async () => {
    const c = await approvedCase("repeat-grant");
    const grants = () => count(c.w.path, "approver_grants");
    const audits = (action: string) => {
      const db = new DatabaseSync(c.w.path, { readOnly: true });
      try {
        return Number((db.prepare("SELECT count(*) AS n FROM access_audit WHERE action = ? AND object_id = ?").get(action, c.r) as { n: number }).n);
      } finally {
        db.close();
      }
    };
    const statusOf = async (action: "GRANT" | "REVOKE") => ((await bodyOf(await c.grant(action))) as { status: string }).status;
    const g0 = grants();
    const a0 = audits("APPROVER_GRANTED");
    // Already assigned: GRANT again (three times) → UNCHANGED, no grant row, no audit row.
    for (let i = 0; i < 3; i++) assert.equal(await statusOf("GRANT"), "UNCHANGED");
    assert.equal(grants(), g0);
    assert.equal(audits("APPROVER_GRANTED"), a0);
    // Remove, remove again → one REVOKE row only.
    assert.equal(await statusOf("REVOKE"), "CHANGED");
    assert.equal(await statusOf("REVOKE"), "UNCHANGED");
    assert.equal(grants(), g0 + 1);
    // Many remove / re-assign cycles: every change is accepted (no cumulative cap) and appended in sequence. 3 Nov: the
    // cycles are spread over time (2 min each) so they stay under the short-time limit (10 new GRANTs / 10 min), which
    // is tested on its own below; the cumulative number of changes is still unlimited.
    for (let i = 0; i < 10; i++) {
      c.w.clock.now = new Date(c.w.clock.now.getTime() + 2 * 60 * 1000);
      assert.equal(await statusOf("GRANT"), "CHANGED");
      assert.equal(await statusOf("REVOKE"), "CHANGED");
    }
    assert.equal(await statusOf("GRANT"), "CHANGED");
    assert.equal(grants(), g0 + 1 + 21);
    // The approval made under the first grant stays invalid after any number of re-assignments.
    assert.equal((await c.pay("start")).body.code, "APPROVAL_INVALID");
    assert.equal(c.paypalCalls(), 0);
  });

  test("short-time assignment limit (3 Nov): 10 new GRANTs in 10 min allowed, the 11th refused with 429 + wait time and nothing changed; repeated GRANT costs nothing; removal never limited; restart keeps the count; re-assigning after the window never restores an old approval", async () => {
    const c = await approvedCase("assign-limit");
    const grants = () => count(c.w.path, "approver_grants");
    const send = async (action: "GRANT" | "REVOKE") => {
      const res = await c.grant(action);
      return { http: res.status, retry: res.headers.get("retry-after"), body: (await bodyOf(res)) as { status?: string; code?: string; retryAfterSeconds?: number; message?: string } };
    };
    const assigned = () => c.w.authStore.isAssignedApprover(c.r, c.ap.principal.id);
    // approvedCase made 1 GRANT at t0. Repeated GRANTs while assigned are UNCHANGED and are not counted.
    for (let i = 0; i < 5; i++) assert.equal((await send("GRANT")).body.status, "UNCHANGED");
    // 9 more real GRANTs (REVOKE between them) at the same instant → 10 in the window, all accepted.
    for (let i = 0; i < 9; i++) {
      assert.equal((await send("REVOKE")).body.status, "CHANGED");
      assert.equal((await send("GRANT")).body.status, "CHANGED", `grant ${i + 2}`);
    }
    // At the limit: a repeated GRANT is still UNCHANGED (200, not 429), and removal works; repeated removal writes nothing.
    assert.equal((await send("GRANT")).body.status, "UNCHANGED");
    assert.equal((await send("REVOKE")).body.status, "CHANGED", "removal is never limited");
    const g = grants();
    assert.equal((await send("REVOKE")).body.status, "UNCHANGED");
    assert.equal(grants(), g);
    // 11th new GRANT: 429, explicit code and wait, no row, assignment unchanged (still removed), refusal audited.
    const refused = await send("GRANT");
    assert.equal(refused.http, 429);
    assert.equal(refused.body.code, "ASSIGNMENT_RATE_LIMITED");
    assert.equal(refused.body.retryAfterSeconds, 600);
    assert.equal(refused.retry, "600");
    assert.match(refused.body.message ?? "", /at most 10 in 10 minutes.*Nothing was changed.*10 min 0 s.*never limited/);
    assert.equal(grants(), g);
    assert.equal(assigned(), false);
    const denied = new DatabaseSync(c.w.path, { readOnly: true });
    const deniedRows = denied.prepare("SELECT detail FROM access_audit WHERE action = 'APPROVER_ASSIGN' AND outcome = 'DENIED' AND object_id = ?").all(c.r) as { detail: string }[];
    denied.close();
    assert.equal(deniedRows.length, 1);
    assert.equal(JSON.parse(deniedRows[0].detail).reason, "RATE_LIMITED");
    // Refused requests do not use up the window: ten more refusals, then the window passes and exactly one place opens.
    for (let i = 0; i < 10; i++) assert.equal((await send("GRANT")).http, 429);
    assert.equal(grants(), g);
    // Restart: a new store and service on the same file (same clock) still see the 10 persisted grants.
    const store2 = new AuthStore(c.w.path, { now: () => c.w.clock.now });
    open.push(store2);
    assert.equal(new AuthService(store2, { now: () => c.w.clock.now }).setApprover(c.a.principal, c.r, c.ap.principal.id, "GRANT").status, "RATE_LIMITED");
    // One second before the window ends: still refused, 1 s to wait. At exactly 10 min: the oldest grants left the window.
    const t0 = c.w.clock.now.getTime();
    c.w.clock.now = new Date(t0 + 10 * 60 * 1000 - 1000);
    const almost = await send("GRANT");
    assert.equal(almost.http, 429);
    assert.equal(almost.body.retryAfterSeconds, 1);
    c.w.clock.now = new Date(t0 + 10 * 60 * 1000);
    assert.equal((await send("GRANT")).body.status, "CHANGED", "the window has passed");
    assert.equal(assigned(), true);
    // Re-assigned after a removal and a full window: the approval made under the first grant is still invalid.
    assert.equal((await c.pay("start")).body.code, "APPROVAL_INVALID");
    assert.equal(c.paypalCalls(), 0);
  });

  test("Quotes-page entry state (3 Nov): GET ?statusFor=<version> lists only that version's approvals, names another version's Active approval apart, and writes nothing — not even when an approval has become invalid", async () => {
    const c = await approvedCase("status-for");
    const ra = c.w.aps.approval(c.approvalId)!;
    const status = async (s: Session, versionId: string, extra = "") => {
      const res = await handlePreview(as(s, "GET", `/p?statusFor=${versionId}${extra}`), c.r, c.w.approvals, c.w.opts);
      return { http: res.status, body: (await bodyOf(res)) as { here?: { id: string; state: string; versionId: string }[]; otherActive?: { id: string; versionNumber: number }[] } };
    };
    const own = await status(c.a, ra.versionId);
    assert.equal(own.http, 200);
    assert.deepEqual(own.body.here!.map((a) => [a.id, a.state]), [[c.approvalId, "ACTIVE"]]);
    assert.deepEqual(own.body.otherActive, []);
    // 5 Nov: the payment fact is part of each line (null before any payment step; no payment record is created by reading).
    assert.equal((own.body.here![0] as { payment?: unknown }).payment, null);
    // Another version of the request (any other version id): the Active approval is NOT shown as this version's.
    const other = await status(c.a, `qv_${randomUUID()}`);
    assert.equal(other.http, 200);
    assert.deepEqual(other.body.here, []);
    assert.deepEqual(other.body.otherActive!.map((a) => a.id), [c.approvalId]);
    // The approver may read it too; another buyer gets 404; bad input 422.
    assert.equal((await status(c.ap, ra.versionId)).http, 200);
    const b = await c.w.login("buyer-b");
    assert.equal((await status(b, ra.versionId)).http, 404);
    assert.equal((await status(c.a, "not-an-id")).http, 422);
    assert.equal((await status(c.a, ra.versionId, `&series=${ra.seriesId}`)).http, 422);
    // Removal makes the approval invalid: the state says so, and reading writes no INVALIDATED event (or anything else).
    assert.equal((await c.grant("REVOKE")).status, 200);
    const events = count(c.w.path, "approval_events");
    const audits = count(c.w.path, "access_audit");
    const after = await status(c.a, ra.versionId);
    assert.equal(after.body.here![0].state, "INVALIDATED");
    assert.equal(count(c.w.path, "approval_events"), events, "no event written by the status read");
    assert.equal(count(c.w.path, "access_audit"), audits, "no audit row written by the status read");
  });

  test("short-time assignment limit: rolling window (each grant ages out on its own); other requests have their own count; other users cannot change or use up the assignment", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const b = await w.login("buyer-b");
    const ap = await w.login("approver");
    const r1 = (await w.recordOf(a, "limit-1")).request.id;
    const r2 = (await w.recordOf(a, "limit-2")).request.id;
    const post = async (s: Session | null, r: string, action: "GRANT" | "REVOKE", extra: Record<string, string> = {}) => {
      const res = await handleApprovers(as(s, "POST", "/g", { approverId: ap.principal.id, action }, extra), r, w.auth, w.opts);
      return { http: res.status, body: (await bodyOf(res)) as { status?: string; retryAfterSeconds?: number } };
    };
    const grantsOn = (r: string) => w.authStore.grants(r).length;
    // Unauthorised callers first: nothing written, and nothing counted against the owner.
    for (let i = 0; i < 12; i++) {
      assert.equal((await post(b, r1, "GRANT")).http, 404, "another buyer: 404");
      assert.equal((await post(ap, r1, "GRANT")).http, 404, "the approver itself: 404");
    }
    assert.equal((await post(null, r1, "GRANT")).http, 401, "signed out");
    assert.notEqual((await post(a, r1, "GRANT", { [CSRF_HEADER]: "wrong" })).http, 200, "wrong CSRF token");
    assert.equal(grantsOn(r1), 0);
    // Owner: 10 grants on r1, 30 s apart (t0 … t0+270 s).
    const t0 = w.clock.now.getTime();
    for (let i = 0; i < 10; i++) {
      w.clock.now = new Date(t0 + i * 30 * 1000);
      assert.equal((await post(a, r1, "GRANT")).body.status, "CHANGED");
      assert.equal((await post(a, r1, "REVOKE")).body.status, "CHANGED");
    }
    const late = await post(a, r1, "GRANT");
    assert.equal(late.http, 429);
    assert.equal(late.body.retryAfterSeconds, 600 - 270, "frees when the oldest grant (t0) leaves the window");
    // Another request of the same buyer is independent.
    assert.equal((await post(a, r2, "GRANT")).body.status, "CHANGED");
    // t0 + 600 s: the first grant aged out → one place; the next one opens 30 s later.
    w.clock.now = new Date(t0 + 600 * 1000);
    assert.equal((await post(a, r1, "GRANT")).body.status, "CHANGED");
    assert.equal((await post(a, r1, "REVOKE")).body.status, "CHANGED");
    const next = await post(a, r1, "GRANT");
    assert.equal(next.http, 429);
    assert.equal(next.body.retryAfterSeconds, 30);
    // B's and the approver's attempts left no grant row on r1: only the owner's 11 GRANT + 11 REVOKE.
    assert.equal(grantsOn(r1), 22);
    assert.ok(w.authStore.grants(r1).every((g) => g.actorId === a.principal.id));
  });

  test("short-time assignment limit under contention: two connections racing for the last place — the count and the insert are one transaction, so exactly 10 grants are written", async () => {
    const w = await world();
    const a = await w.login("buyer-a");
    const ap = await w.login("approver");
    await w.auth.createAccount("approver2", "APPROVER", "Approver 2", randomBytes(12).toString("base64url"));
    const ap2 = w.auth.principalOfAccount("approver2")!;
    const r = (await w.recordOf(a, "limit-race")).request.id;
    // 9 grants used (approver toggled), approver left removed.
    for (let i = 0; i < 9; i++) {
      assert.equal(w.auth.setApprover(a.principal, r, ap.principal.id, "GRANT").status, "CHANGED");
      assert.equal(w.auth.setApprover(a.principal, r, ap.principal.id, "REVOKE").status, "CHANGED");
    }
    const other = new AuthStore(w.path, { busyTimeoutMs: 50, now: () => w.clock.now });
    open.push(other);
    const otherSvc = new AuthService(other, { now: () => w.clock.now });
    // While the first request is between its count and its insert (inside BEGIN IMMEDIATE), the second one tries.
    const original = w.authStore.insertGrant.bind(w.authStore);
    let inner: string | null = null;
    w.authStore.insertGrant = (...args) => {
      try {
        inner = otherSvc.setApprover(a.principal, r, ap2.id, "GRANT").status;
      } catch (err) {
        inner = String((err as Error).message);
      }
      return original(...args);
    };
    const first = w.auth.setApprover(a.principal, r, ap.principal.id, "GRANT");
    w.authStore.insertGrant = original;
    assert.equal(first.status, "CHANGED", "the first request takes the last place");
    assert.match(inner ?? "", /locked|busy/i, "the second request cannot read the count while the first holds the write lock");
    // The second request, sent again after the first committed, sees 10 and is refused.
    assert.equal(otherSvc.setApprover(a.principal, r, ap2.id, "GRANT").status, "RATE_LIMITED");
    assert.equal(w.authStore.grants(r).filter((g) => g.action === "GRANT").length, 10);
    assert.equal(w.authStore.isAssignedApprover(r, ap2.id), false);
    // Removal is still possible at the limit, from either connection.
    assert.equal(otherSvc.setApprover(a.principal, r, ap.principal.id, "REVOKE").status, "CHANGED");
  });

  test("removed and re-assigned (clock stepped back): the old approval stays invalid; a new approval by the same approver is valid and can pay (MOCK)", async () => {
    const c = await approvedCase("re-assign");
    back(c.w, 60 * 60 * 1000);
    await c.grant("REVOKE");
    back(c.w, 60 * 60 * 1000);
    assert.equal((await c.grant("GRANT")).status, 200);
    assert.equal((await c.pay("start")).body.code, "APPROVAL_INVALID", "re-assigning does not restore the old approval");
    assert.equal(c.paypalCalls(), 0);
    const again = await c.approve();
    assert.equal(again.status, 201, "a new approval is needed and possible");
    const fresh = ((await bodyOf(again)).approval as { id: string }).id;
    assert.notEqual(fresh, c.approvalId);
    assert.equal((await c.pay("start", fresh)).status, 201);
    const order = await c.pay("order", fresh);
    assert.equal(order.body.code, "ORDER_READY", JSON.stringify(order.body).slice(0, 300));
    c.w.paypal.approve(order.body.orderId as string);
    const cap = await c.pay("capture", fresh, { orderId: order.body.orderId });
    assert.equal(cap.body.status ?? cap.body.code, "PAID", JSON.stringify(cap.body).slice(0, 300));
  });

  test("removal after the order and before the capture (clock stepped back): capture refused, no capture request", async () => {
    const c = await approvedCase("before-capture");
    assert.equal((await c.pay("start")).status, 201);
    const order = await c.pay("order");
    c.w.paypal.approve(order.body.orderId as string);
    back(c.w, 60 * 60 * 1000);
    await c.grant("REVOKE");
    const cap = await c.pay("capture", c.approvalId, { orderId: order.body.orderId });
    assert.equal(cap.body.code, "APPROVAL_INVALID", JSON.stringify(cap.body).slice(0, 300));
    assert.equal(c.w.paypal.calls.capture.length, 0);
  });

  test("removal racing the capture: a removal cannot commit inside the capture's claim transaction; whichever commits first decides; a capture already sent is kept as PAID", async () => {
    const c = await approvedCase("race");
    assert.equal((await c.pay("start")).status, 201);
    const order = await c.pay("order");
    c.w.paypal.approve(order.body.orderId as string);
    // Inside the payment store's write transaction (eligibility check + claim), try the removal on another connection.
    const other = new AuthStore(c.w.path, { busyTimeoutMs: 50, now: () => c.w.clock.now });
    const original = c.w.pay.transitionChecked.bind(c.w.pay);
    let attempt: string | null = null;
    c.w.pay.transitionChecked = (id, g, patch, iso, check) =>
      original(id, g, patch, iso, () => {
        try {
          new AuthService(other).setApprover(c.a.principal, c.r, c.ap.principal.id, "REVOKE");
          attempt = "COMMITTED";
        } catch (err) {
          attempt = String((err as Error).message);
        }
        return check();
      });
    const cap = await c.pay("capture", c.approvalId, { orderId: order.body.orderId });
    c.w.pay.transitionChecked = original;
    other.close();
    assert.match(attempt ?? "", /locked|busy/i, "the removal waits for the claim transaction");
    assert.equal(cap.body.status ?? cap.body.code, "PAID", "the claim committed first, so the capture goes on");
    assert.equal(c.w.paypal.calls.capture.length, 1);
    // The removal commits afterwards; the payment stays PAID (not undone), the approval is invalid from now on.
    assert.equal((await c.grant("REVOKE")).status, 200);
    assert.equal(c.w.approvals.view(c.a.principal, c.r, c.approvalId)!.validity.state, "INVALIDATED");
    assert.equal(c.w.pay.get(c.w.approvals.currentPayment(c.a.principal, c.r, c.approvalId)!.recordId)!.status, "PAID");
  });

  test("an approver's approval from before v17 (grant not recorded) cannot pay even while the approver is assigned; nothing is inferred; a new approval is needed; v17 refuses new approver rows without a GRANT", async () => {
    const c = await approvedCase("legacy-basis");
    // Make the existing approval look like a pre-v17 row: same values, no grant sequence (only possible with the
    // trigger dropped — exactly the state of rows written before the column existed).
    const legacyId = `ap_${randomUUID()}`;
    const raw = new DatabaseSync(c.w.path);
    const cols = (raw.prepare("SELECT name FROM pragma_table_info('approvals')").all() as { name: string }[]).map((x) => x.name);
    const pick = cols.map((n) => (n === "id" ? "?" : n === "idempotency_key" ? "?" : n === "approver_grant_seq" ? "NULL" : n)).join(", ");
    raw.exec("DROP TRIGGER approvals_grant_basis");
    raw.prepare(`INSERT INTO approvals (${cols.join(", ")}) SELECT ${pick} FROM approvals WHERE id = ?`).run(legacyId, randomUUID(), c.approvalId);
    raw.exec(APPROVAL_V17_TRIGGER);
    // The trigger refuses an approver row without a matching GRANT.
    assert.throws(() => raw.prepare(`INSERT INTO approvals (${cols.join(", ")}) SELECT ${pick} FROM approvals WHERE id = ?`).run(`ap_${randomUUID()}`, randomUUID(), c.approvalId), /must name the GRANT/);
    raw.close();
    // Revoke the fresh approval so only the legacy-shaped one could pay (still assigned: no grant change).
    assert.equal((await handleRevoke(as(c.a, "POST", "/r", { note: "test" }), c.r, c.approvalId, c.w.approvals, c.w.opts)).status, 200);
    assert.ok(canReadRequest(c.ap.principal, c.r), "the approver is still assigned");
    const start = await c.pay("start", legacyId);
    assert.equal(start.body.code, "APPROVAL_INVALID", JSON.stringify(start.body).slice(0, 300));
    assert.deepEqual((start.body.validity as { reasons: string[] }).reasons, ["GRANT_BASIS_UNKNOWN"]);
    assert.equal(c.paypalCalls(), 0);
    assert.equal(c.w.aps.approval(legacyId)!.approverGrantSeq, null, "no basis is invented");
    const again = await c.approve();
    assert.equal(again.status, 201, "a new approval by the assigned approver is possible");
    assert.equal(typeof ((await bodyOf(again)).approval as { approverGrantSeq: number }).approverGrantSeq, "number");
  });
});
