// Automated tests for 24 Oct (follow-up to owner acceptance): unchanged saves write nothing, and request
// revision history (schema v8) — atomic snapshots, immutability, migration baseline without invented
// history, read-only API with the same access boundary, and no false "request changed" on quotes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { emptyInput, type ProcurementInput, type ProcurementRecord } from "../src/lib/procurement.ts";
import { SCHEMA_VERSION, openDatabase } from "../src/server/db/database.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { handleGetRevision, handleListRevisions, handleUpdate } from "../src/server/procurement/http.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { testGate, ALL_REQUESTS } from "./helpers/principals.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-history-test-"));
});
after(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const dbPath = () => join(dir, `app-${++counter}.sqlite`);
function store(path = dbPath(), now?: () => Date) {
  const s = new ProcurementStore(path, now ? { now } : {});
  open.push(s);
  return s;
}

const line = (name: string, quantity = "10") => ({ id: null as string | null, name, quantity, unit: "pcs", material: "", specification: "", customization: "", notes: "" });
function input(over: Partial<ProcurementInput> = {}): ProcurementInput {
  return { ...emptyInput(), title: "Bottles", buyerType: "BUSINESS", buyerCompany: "Lumen", items: [line("A"), line("B")], ...over };
}
function valid(body: unknown, mode: "create" | "update" = "create") {
  const r = validateProcurementInput(body, mode);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return r.value;
}
/** Exactly what the edit page sends for an untouched form (recordToInput). */
const formOf = (r: ProcurementRecord, over: Partial<ProcurementInput> = {}): ProcurementInput => ({
  ...emptyInput(),
  title: r.title,
  buyerType: r.buyerType ?? "",
  buyerCompany: r.buyerCompany ?? "",
  buyerPersonName: r.buyerPersonName ?? "",
  supplierName: r.supplierName ?? "",
  shipFrom: r.shipFrom ?? "",
  shipTo: r.shipTo ?? "",
  budgetCurrency: r.budgetCurrency ?? "",
  budgetMax: r.budgetMax ?? "",
  requiredShipDate: r.requiredShipDate ?? "",
  expectedDeliveryDate: r.expectedDeliveryDate ?? "",
  paymentTerms: r.paymentTerms ?? "",
  additionalRequirements: r.additionalRequirements ?? "",
  items: r.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity === null ? "" : String(i.quantity), unit: i.unit ?? "", material: i.material ?? "", specification: i.specification ?? "", customization: i.customization ?? "", notes: i.notes ?? "" })),
  ...over,
});
const historyCount = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare("SELECT count(*) AS n FROM procurement_request_revisions").get() as { n: number }).n);
  } finally {
    db.close();
  }
};
const LOCAL = "http://127.0.0.1:3000";
const http = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${LOCAL}${path}`, { method, headers: { host: "127.0.0.1:3000", origin: LOCAL, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("saves that change nothing", () => {
  test("an untouched form: NO_CHANGES, same revision and updated_at, no history row; HTTP says 'No changes to save.'", async () => {
    const path = dbPath();
    let clock = new Date("2026-10-24T10:00:00.000Z");
    const s = store(path, () => clock);
    const rec = s.create(valid(input({ budgetCurrency: "USD", budgetMax: "1800.00", paymentTerms: "30% deposit\n70% before shipment", requiredShipDate: "2026-12-10" })), "USER_INPUT");
    clock = new Date("2026-10-24T11:00:00.000Z");
    const out = s.update(rec.id, 1, valid(formOf(rec), "update"));
    assert.equal(out.status, "NO_CHANGES");
    const after = s.get(rec.id)!;
    assert.deepEqual([after.revision, after.updatedAt], [1, "2026-10-24T10:00:00.000Z"]);
    assert.equal(historyCount(path), 1);
    const res = await handleUpdate(http("PUT", `/api/procurements/${rec.id}`, { ...formOf(rec), revision: 1 }), rec.id, s, { enabled: true, auth: testGate() });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { code: string; message: string; record: ProcurementRecord };
    assert.deepEqual([data.code, data.message, data.record.revision], ["NO_CHANGES", "No changes to save.", 1]);
    assert.equal(historyCount(path), 1);
  });

  test("leading / trailing spaces are trimmed by the existing rules (no change); case, inner spaces, order, quantity, buyer type are changes", () => {
    const s = store();
    const rec = s.create(valid(input()), "USER_INPUT");
    assert.equal(s.update(rec.id, 1, valid(formOf(rec, { title: "  Bottles  " }), "update")).status, "NO_CHANGES");
    let r = rec;
    const changes: Partial<ProcurementInput>[] = [
      { title: "bottles" },
      { title: "bott  les" },
      { buyerType: "INDIVIDUAL", buyerPersonName: "Tan" },
    ];
    for (const over of changes) {
      const u = s.update(r.id, r.revision, valid(formOf(r, over), "update"));
      assert.equal(u.status, "UPDATED", JSON.stringify(over));
      r = (u as { record: ProcurementRecord }).record;
    }
    // Each case is built from the form of the latest record (as the edit page would).
    type Items = ProcurementInput["items"];
    const itemCases: ((items: Items) => Items)[] = [
      (i) => [i[1], i[0]], // reorder
      (i) => [{ ...i[0], quantity: "11" }, i[1]], // quantity
      (i) => [{ ...i[0], name: "A2" }, i[1]], // name
      (i) => [i[0]], // delete a line
      (i) => [...i, line("C")], // add a line
    ];
    for (const change of itemCases) {
      const f = formOf(r);
      const u = s.update(r.id, r.revision, valid({ ...f, items: change(f.items) }, "update"));
      assert.equal(u.status, "UPDATED");
      r = (u as { record: ProcurementRecord }).record;
    }
    assert.equal(r.revision, 1 + changes.length + 5);
  });

  test("a stale page still gets a conflict even when its content equals the stored record", async () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input()), "USER_INPUT");
    const u = s.update(rec.id, 1, valid(formOf(rec, { title: "Bottles v2" }), "update"));
    assert.equal(u.status, "UPDATED");
    const latest = (u as { record: ProcurementRecord }).record;
    const res = await handleUpdate(http("PUT", `/api/procurements/${rec.id}`, { ...formOf(latest), revision: 1 }), rec.id, s, { enabled: true, auth: testGate() });
    assert.equal(res.status, 409);
    assert.equal(historyCount(path), 2);
  });
});

describe("revision history", () => {
  test("create stores revision 1; each real change stores the next; old revisions never change; ids stay distinct", () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input({ paymentTerms: "30% deposit" })), "USER_INPUT");
    assert.deepEqual(s.revisions(rec.id).map((r) => [r.revision, r.origin, r.current]), [[1, "SAVED", true]]);
    const [a, b] = rec.items.map((i) => i.id);

    // rev 2: rename A, change quantity, reorder; rev 3: delete B, add C.
    const f1 = formOf(rec);
    const r2 = (s.update(rec.id, 1, valid({ ...f1, paymentTerms: "50% deposit", items: [f1.items[1], { ...f1.items[0], name: "A renamed", quantity: "99" }] }, "update")) as { record: ProcurementRecord }).record;
    const f2 = formOf(r2);
    const r3 = (s.update(rec.id, 2, valid({ ...f2, items: [f2.items[1], line("C")] }, "update")) as { record: ProcurementRecord }).record;
    assert.equal(r3.revision, 3);

    const h1 = s.revision(rec.id, 1)!.snapshot.record;
    const h2 = s.revision(rec.id, 2)!.snapshot.record;
    const h3 = s.revision(rec.id, 3)!.snapshot.record;
    assert.deepEqual(h1.items.map((i) => [i.id, i.name, i.quantity]), [[a, "A", 10], [b, "B", 10]]);
    assert.equal(h1.paymentTerms, "30% deposit");
    assert.deepEqual(h2.items.map((i) => [i.id, i.name, i.quantity]), [[b, "B", 10], [a, "A renamed", 99]]);
    assert.equal(h3.items[0].id, a);
    assert.notEqual(h3.items[1].id, b, "new line has a new id; B's id is not reused");
    assert.ok(!r3.items.some((i) => i.id === b), "B is deleted from the current record …");
    assert.ok(h2.items.some((i) => i.id === b), "… but revision 2 still shows it (read from the snapshot, not current items)");
    assert.deepEqual(s.revisions(rec.id).map((r) => [r.revision, r.current]), [[3, true], [2, false], [1, false]]);
    assert.ok(s.revisions(rec.id).every((r) => r.savedAt === r.archivedAt && r.origin === "SAVED"));
    assert.equal(s.revision(rec.id, 2)!.snapshotVersion, 2);
  });

  test("two tabs: the stale save gets CONFLICT and leaves no history row; failed validation leaves none either", () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input()), "USER_INPUT");
    assert.equal(s.update(rec.id, 1, valid(formOf(rec, { title: "Tab A" }), "update")).status, "UPDATED");
    assert.equal(s.update(rec.id, 1, valid(formOf(rec, { title: "Tab B" }), "update")).status, "CONFLICT");
    assert.equal(s.update(rec.id, 2, valid(formOf(rec, { title: "Tab A", buyerType: "" }), "update")).status, "INVALID_ITEMS");
    assert.equal(historyCount(path), 2);
    assert.equal(s.get(rec.id)!.title, "Tab A");
  });

  test("if the snapshot cannot be written, the whole save rolls back (create and edit)", () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input()), "USER_INPUT");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER test_fail_history BEFORE INSERT ON procurement_request_revisions BEGIN SELECT RAISE(ABORT, 'simulated history failure'); END;");
    raw.close();
    assert.throws(() => s.update(rec.id, 1, valid(formOf(rec, { title: "Edited", items: [line("New only")] }), "update")), /simulated history failure/);
    const after = s.get(rec.id)!;
    assert.deepEqual([after.revision, after.title, after.items.map((i) => i.id)], [1, "Bottles", rec.items.map((i) => i.id)]);
    const before = s.list(100, ALL_REQUESTS).length;
    assert.throws(() => s.create(valid(input({ title: "Never saved" })), "USER_INPUT"), /simulated history failure/);
    assert.equal(s.list(100, ALL_REQUESTS).length, before);
  });

  test("history rows cannot be changed or deleted; only the current revision can be recorded; revisions cannot skip", () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input()), "USER_INPUT");
    const raw = new DatabaseSync(path);
    assert.throws(() => raw.exec("UPDATE procurement_request_revisions SET snapshot = '{}'"), /immutable/);
    assert.throws(() => raw.exec("DELETE FROM procurement_request_revisions"), /cannot be deleted/);
    assert.throws(() => raw.prepare("DELETE FROM procurement_requests WHERE id = ?").run(rec.id), /FOREIGN KEY|constraint/i);
    const snap = s.revision(rec.id, 1)!.snapshot;
    const fake = JSON.stringify({ ...snap, record: { ...snap.record, revision: 5 } });
    assert.throws(() => raw.prepare("INSERT INTO procurement_request_revisions VALUES (?, 5, 'SAVED', 2, ?, ?, ?)").run(rec.id, fake, rec.updatedAt, rec.updatedAt), /current revision/);
    assert.throws(() => raw.prepare("UPDATE procurement_requests SET revision = 3 WHERE id = ?").run(rec.id), /next revision/);
    raw.close();
  });

  test("history survives closing and reopening the database (server restart)", () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input()), "USER_INPUT");
    s.update(rec.id, 1, valid(formOf(rec, { title: "v2" }), "update"));
    const before = JSON.stringify([s.revisions(rec.id), s.revision(rec.id, 1), s.revision(rec.id, 2)]);
    s.close();
    const again = store(path);
    assert.equal(JSON.stringify([again.revisions(rec.id), again.revision(rec.id, 1), again.revision(rec.id, 2)]), before);
  });
});

describe("history API", () => {
  test("list and get: same local guard as the record; unknown request / revision → 404; production → 404", async () => {
    const s = store();
    const rec = s.create(valid(input()), "USER_INPUT");
    const list = await handleListRevisions(http("GET", `/api/procurements/${rec.id}/revisions`), rec.id, s, { enabled: true, auth: testGate() });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { revisions: unknown[] }).revisions.length, 1);
    const got = await handleGetRevision(http("GET", "/x"), rec.id, "1", s, { enabled: true, auth: testGate() });
    assert.equal(((await got.json()) as { revision: { snapshot: { record: { id: string } } } }).revision.snapshot.record.id, rec.id);
    for (const rev of ["2", "0", "-1", "1.5", "abc", "9999999999"]) assert.equal((await handleGetRevision(http("GET", "/x"), rec.id, rev, s, { enabled: true, auth: testGate() })).status, 404, rev);
    assert.equal((await handleListRevisions(http("GET", "/x"), `pr_${randomUUID()}`, s, { enabled: true, auth: testGate() })).status, 404);
    assert.equal((await handleListRevisions(http("GET", "/x", undefined, { host: "evil.example" }), rec.id, s, { enabled: true, auth: testGate() })).status, 403);
    assert.equal((await handleGetRevision(http("GET", "/x"), rec.id, "1", s, { enabled: false, auth: testGate() })).status, 404);
    assert.equal(s.revisions(rec.id).length, 1, "reading history never writes");
  });
});

describe("quote snapshots and 'request changed'", () => {
  test("an unchanged save does not make a saved quote look outdated; a real change still does", () => {
    const path = dbPath();
    const s = store(path);
    const q = new QuoteStore(path);
    open.push(q);
    const rec = s.create(valid(input()), "USER_INPUT");
    const v1 = q.createSeries(rec.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      name: "Q",
      supplierDisplayName: null,
      version: { rawText: "quote", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(v1.status === "CREATED");
    assert.equal(s.update(rec.id, 1, valid(formOf(rec), "update")).status, "NO_CHANGES");
    assert.equal(s.get(rec.id)!.revision, v1.version.requestRevision, "the page shows 'still at this revision'");
    const v2 = q.addVersion(rec.id, v1.series.id, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: v1.version.id, version: { ...v1.version, rawText: "v2", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null } });
    assert.equal(v2.status, "CREATED", "no false REQUEST_CHANGED");
    assert.equal(s.update(rec.id, 1, valid(formOf(rec, { title: "changed" }), "update")).status, "UPDATED");
    const v3 = q.addVersion(rec.id, v1.series.id, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: (v2 as { version: { id: string } }).version.id, version: { rawText: "v3", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null } });
    assert.equal(v3.status, "REQUEST_CHANGED");
  });
});

describe("v7 → v8 migration", () => {
  /** A genuine v7 file: requests at revisions 1 and 3, a quote, payments — and no history table. */
  function makeV7(path: string) {
    const ps = new PaymentStore(path);
    new PaymentService({ store: ps, gateway: null, payeeMerchantId: null }).createTestRecord();
    ps.close();
    const s = new ProcurementStore(path);
    const q = new QuoteStore(path);
    const a = s.create(valid(input({ title: "Edited twice" })), "DEMO_SAMPLE");
    let r = (s.update(a.id, 1, valid(formOf(a, { title: "Edited twice (2)" }), "update")) as { record: ProcurementRecord }).record;
    r = (s.update(a.id, 2, valid(formOf(r, { title: "Edited twice (3)" }), "update")) as { record: ProcurementRecord }).record;
    const b = s.create(valid(input({ title: "Never edited" })), "USER_INPUT");
    q.createSeries(b.id, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, name: "Q", supplierDisplayName: null, version: { rawText: "text\r\n", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null } });
    s.close();
    q.close();
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TRIGGER procurement_requests_revision_chain; DROP TABLE procurement_request_revisions; PRAGMA user_version = 7;`);
    raw.close();
    return { a: r, b };
  }
  const dumpAll = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'procurement_request_revisions' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
      return Object.fromEntries(tables.map((t) => [t, JSON.stringify((db.prepare(`SELECT * FROM "${t}"`).all() as object[]).map((r) => JSON.stringify(r)).sort())]));
    } finally {
      db.close();
    }
  };

  test("backup first; one baseline per request at its CURRENT revision; no revisions 1–2 invented; times kept apart; nothing else changes", () => {
    const path = dbPath();
    const { a, b } = makeV7(path);
    const before = dumpAll(path);
    const backups: string[] = [];
    openDatabase(path, { onBackup: (f) => backups.push(f) }).close();
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(String.raw`\.v7-before-v${SCHEMA_VERSION}\.`));
    assert.deepEqual(dumpAll(path), before, "every existing table unchanged");
    const s = store(path);
    const ha = s.revisions(a.id);
    assert.deepEqual(ha.map((r) => [r.revision, r.origin, r.current]), [[3, "MIGRATION_BASELINE", true]]);
    assert.equal(ha[0].savedAt, a.updatedAt, "business time = when revision 3 was really saved");
    assert.notEqual(ha[0].archivedAt, ha[0].savedAt, "archive time = migration time, kept separately");
    assert.equal(s.revision(a.id, 1), null);
    assert.equal(s.revision(a.id, 2), null);
    assert.deepEqual(s.revision(a.id, 3)!.snapshot.record, s.get(a.id), "baseline = the real current state");
    assert.deepEqual(s.revisions(b.id).map((r) => [r.revision, r.origin]), [[1, "MIGRATION_BASELINE"]]);
    // The next real edit continues the chain with a SAVED row.
    const u = s.update(a.id, 3, valid(formOf(s.get(a.id)!, { title: "After migration" }), "update"));
    assert.equal(u.status, "UPDATED");
    assert.deepEqual(s.revisions(a.id).map((r) => [r.revision, r.origin]), [[4, "SAVED"], [3, "MIGRATION_BASELINE"]]);
    s.close();
    const again: string[] = [];
    openDatabase(path, { onBackup: (f) => again.push(f) }).close();
    assert.deepEqual(again, []);
  });
});
