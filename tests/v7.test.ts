// Automated tests for schema v7 (24 Oct): buyer type (Business / Individual / not recorded), buyer name
// fields, revision checks on them, item references, request snapshots v1 vs v2, and the v6 → v7 migration
// (backup first, every existing row unchanged, immutability triggers still active, rollback on failure).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { emptyInput, shortItemRef, type ProcurementInput, type ProcurementRecord } from "../src/lib/procurement.ts";
import { snapshotBuyer, type RequestSnapshot } from "../src/lib/quote-versions.ts";
import { SCHEMA_VERSION, openDatabase } from "../src/server/db/database.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { handleCreate, handleUpdate } from "../src/server/procurement/http.ts";
import { BUYER_TYPE_CLEARED_MESSAGE, ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { addTestAccounts, testGate } from "./helpers/principals.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-v7-test-"));
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
const dbPath = () => join(dir, `app-${++counter}.sqlite`);

const line = (name: string) => ({ id: null, name, quantity: "10", unit: "pcs", material: "", specification: "", customization: "", notes: "" });
function input(over: Partial<ProcurementInput> = {}): ProcurementInput {
  return { ...emptyInput(), title: "Bottles", items: [line("A"), line("B"), line("C")], ...over };
}
const fieldsOf = (body: unknown, mode: "create" | "update" = "create") => {
  const r = validateProcurementInput(body, mode);
  return r.ok ? [] : r.errors.map((e) => e.field);
};
function valid(body: unknown, mode: "create" | "update" = "create") {
  const r = validateProcurementInput(body, mode);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return r.value;
}
const formOf = (r: ProcurementRecord, over: Partial<ProcurementInput> = {}): ProcurementInput => ({
  ...emptyInput(),
  title: r.title,
  buyerType: r.buyerType ?? "",
  buyerCompany: r.buyerCompany ?? "",
  buyerPersonName: r.buyerPersonName ?? "",
  items: r.items.map((i) => ({ ...line(i.name), id: i.id })),
  ...over,
});

const LOCAL = "http://127.0.0.1:3000";
const http = (method: string, path: string, body: unknown) =>
  new Request(`${LOCAL}${path}`, { method, headers: { host: "127.0.0.1:3000", origin: LOCAL, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("buyer type", () => {
  test("new requests must say Business or Individual; each type requires its own name field", () => {
    assert.deepEqual(fieldsOf(input()), ["buyerType"]);
    assert.deepEqual(fieldsOf(input({ buyerType: "COMPANY" })), ["buyerType"]);
    assert.deepEqual(fieldsOf(input({ buyerType: "BUSINESS" })), ["buyerCompany"]);
    assert.deepEqual(fieldsOf(input({ buyerType: "INDIVIDUAL" })), ["buyerPersonName"]);
    const biz = valid(input({ buyerType: "BUSINESS", buyerCompany: " Lumen Pte. Ltd. ", buyerPersonName: "" }));
    assert.deepEqual([biz.buyerType, biz.buyerCompany, biz.buyerPersonName], ["BUSINESS", "Lumen Pte. Ltd.", null]);
    const person = valid(input({ buyerType: "INDIVIDUAL", buyerPersonName: "Tan Wei", buyerCompany: "" }));
    assert.deepEqual([person.buyerType, person.buyerPersonName, person.buyerCompany], ["INDIVIDUAL", "Tan Wei", null]);
    const personWithOrg = valid(input({ buyerType: "INDIVIDUAL", buyerPersonName: "Tan Wei", buyerCompany: "Hobby club" }));
    assert.equal(personWithOrg.buyerCompany, "Hobby club", "Company / Organization is optional for an individual");
    assert.deepEqual(fieldsOf(input({ buyerType: "INDIVIDUAL", buyerPersonName: "x".repeat(201) })), ["buyerPersonName"]);
    assert.deepEqual(fieldsOf(input({ buyerType: "INDIVIDUAL", buyerPersonName: "Tan\nWei" })), ["buyerPersonName"]);
  });

  test("stored, returned, and changed only through the revision check", async () => {
    const path = dbPath();
    const store = new ProcurementStore(path);
    open.push(store);
    addTestAccounts(path);
    const created = await handleCreate(http("POST", "/api/procurements", input({ buyerType: "INDIVIDUAL", buyerPersonName: "Tan Wei" })), store, { enabled: true, auth: testGate() });
    assert.equal(created.status, 201);
    const record = ((await created.json()) as { record: ProcurementRecord }).record;
    assert.deepEqual([record.buyerType, record.buyerPersonName, record.buyerCompany], ["INDIVIDUAL", "Tan Wei", null]);

    const toBusiness = { ...formOf(record, { buyerType: "BUSINESS", buyerCompany: "Tan Trading" }), revision: 1 };
    const ok = await handleUpdate(http("PUT", `/api/procurements/${record.id}`, toBusiness), record.id, store, { enabled: true, auth: testGate() });
    assert.equal(ok.status, 200);
    assert.equal(store.get(record.id)!.buyerType, "BUSINESS");
    assert.equal(store.get(record.id)!.revision, 2);

    const stale = await handleUpdate(http("PUT", `/api/procurements/${record.id}`, { ...formOf(record), revision: 1 }), record.id, store, { enabled: true, auth: testGate() });
    assert.equal(stale.status, 409, "a stale tab cannot switch the type back");
    assert.equal(store.get(record.id)!.buyerType, "BUSINESS");

    const cleared = await handleUpdate(http("PUT", `/api/procurements/${record.id}`, { ...formOf(store.get(record.id)!, { buyerType: "" }), revision: 2 }), record.id, store, { enabled: true, auth: testGate() });
    assert.equal(cleared.status, 422);
    assert.match(JSON.stringify(await cleared.json()), new RegExp(BUYER_TYPE_CLEARED_MESSAGE.slice(0, 30)));
    assert.equal(store.get(record.id)!.revision, 2, "nothing written");
  });

  test("an old request (type not recorded) can be edited without choosing; once chosen it cannot be cleared", () => {
    const path = dbPath();
    const store = new ProcurementStore(path);
    open.push(store);
    const r = store.create(valid(input({ buyerType: "BUSINESS", buyerCompany: "Old Co" })), "USER_INPUT");
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE procurement_requests SET buyer_type = NULL WHERE id = ?").run(r.id); // as left by the v7 migration
    raw.close();
    const old = store.get(r.id)!;
    assert.equal(old.buyerType, null);
    const kept = store.update(r.id, old.revision, valid(formOf(old, { title: "Edited" }), "update"));
    assert.ok(kept.status === "UPDATED" && kept.record.buyerType === null && kept.record.buyerCompany === "Old Co");
    const set = store.update(r.id, kept.record.revision, valid(formOf(kept.record, { buyerType: "BUSINESS" }), "update"));
    assert.ok(set.status === "UPDATED" && set.record.buyerType === "BUSINESS");
    const clear = store.update(r.id, set.record.revision, valid(formOf(set.record, { buyerType: "" }), "update"));
    assert.equal(clear.status, "INVALID_ITEMS");
  });

  test("the payment module never reads buyer type (it cannot change permission, payee or amount)", () => {
    for (const file of readdirSync(join("src", "server", "payments"))) {
      assert.doesNotMatch(readFileSync(join("src", "server", "payments", file), "utf8"), /buyer_?type|buyerPersonName|BUYER_TYPES/i, file);
    }
  });
});

describe("item reference", () => {
  test("IT- reference is derived from the line id; edits and reordering keep both", () => {
    const store = new ProcurementStore(dbPath());
    open.push(store);
    const r = store.create(valid(input({ buyerType: "INDIVIDUAL", buyerPersonName: "P" })), "USER_INPUT");
    const refs = r.items.map((i) => shortItemRef(i.id));
    assert.match(refs[0], /^IT-[0-9A-F]{8}$/);
    assert.equal(refs[0], `IT-${r.items[0].id.slice(4, 12).toUpperCase()}`);
    const reordered = formOf(r);
    reordered.items = [reordered.items[2], { ...reordered.items[0], name: "A renamed", quantity: "99" }, reordered.items[1]];
    const u = store.update(r.id, 1, valid(reordered, "update"));
    assert.ok(u.status === "UPDATED");
    assert.deepEqual(u.record.items.map((i) => shortItemRef(i.id)), [refs[2], refs[0], refs[1]]);
    assert.deepEqual(u.record.items.map((i) => i.id), [r.items[2].id, r.items[0].id, r.items[1].id], "copy uses the full id, which is unchanged");
  });
});

describe("request snapshots across schema versions", () => {
  test("new quote versions store snapshot v2 with buyer fields; v1 snapshots read as 'not recorded at the time'", () => {
    const path = dbPath();
    const p = new ProcurementStore(path);
    const q = new QuoteStore(path);
    open.push(p, q);
    const r = p.create(valid(input({ buyerType: "BUSINESS", buyerCompany: "Lumen" })), "USER_INPUT");
    const saved = q.createSeries(r.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      name: "Q",
      supplierDisplayName: null,
      version: { rawText: "text", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(saved.status === "CREATED");
    assert.equal(saved.version.requestSnapshot.snapshotVersion, 2);
    assert.deepEqual(snapshotBuyer(saved.version.requestSnapshot), { recorded: true, buyerType: "BUSINESS", buyerPersonName: null });
    const { buyerType: _t, buyerPersonName: _n, ...v1record } = saved.version.requestSnapshot.record;
    void _t;
    void _n;
    const v1: RequestSnapshot = { snapshotVersion: 1, capturedAt: "2026-10-23T12:00:00.000Z", record: v1record };
    assert.deepEqual(snapshotBuyer(v1), { recorded: false });
  });
});

// ---------------------------------------------------------------- migration

/** A genuine v6 file: payments, requests with items, one quote version — and none of the v7 objects. */
function makeV6(path: string) {
  const ps = new PaymentStore(path);
  new PaymentService({ store: ps, gateway: null, payeeMerchantId: null }).createTestRecord();
  ps.close();
  const p = new ProcurementStore(path);
  const q = new QuoteStore(path);
  const r = p.create(valid(input({ buyerType: "BUSINESS", buyerCompany: "Lumen Pte. Ltd." })), "DEMO_SAMPLE");
  const saved = q.createSeries(r.id, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: 1,
    name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118 (中文)",
    supplierDisplayName: null,
    version: { rawText: "报价编号：QT-DEMO-2026-118\r\n总价 人民币 11,760.00 元\t", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "DEMO_SAMPLE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
  });
  assert.ok(saved.status === "CREATED");
  p.close();
  q.close();
  const raw = new DatabaseSync(path);
  // v6 snapshots were snapshotVersion 1 without buyer fields: rewrite this fixture row to that exact shape
  // (triggers dropped and re-created only inside this fixture; the app never does this).
  const snap = JSON.parse(String((raw.prepare("SELECT request_snapshot FROM quote_versions").get() as { request_snapshot: string }).request_snapshot));
  delete snap.record.buyerType;
  delete snap.record.buyerPersonName;
  snap.snapshotVersion = 1;
  raw.exec(`
    DROP TABLE quote_version_supplier_refs; DROP TABLE quote_extraction_reviews; DROP TABLE quote_extraction_runs;
    DROP TRIGGER quote_versions_immutable;`);
  raw.prepare("UPDATE quote_versions SET request_snapshot = ?").run(JSON.stringify(snap));
  raw.exec(`CREATE TRIGGER quote_versions_immutable BEFORE UPDATE ON quote_versions BEGIN SELECT RAISE(ABORT, 'quote versions are immutable'); END;
    ALTER TABLE procurement_requests DROP COLUMN buyer_type; ALTER TABLE procurement_requests DROP COLUMN buyer_person_name;
    PRAGMA user_version = 6;`);
  raw.close();
  return { requestId: r.id, versionId: saved.version.id };
}

function dumpAll(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const out: Record<string, string> = {};
    for (const t of tables) {
      const rows = (db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]).map((r) => {
        const { buyer_type: _t, buyer_person_name: _n, ...rest } = r;
        void _t;
        void _n;
        return JSON.stringify(rest);
      });
      out[t] = rows.sort().join("\n");
    }
    return out;
  } finally {
    db.close();
  }
}

describe("v6 → v7 migration", () => {
  test("backup first; every existing row identical; old requests 'not recorded'; triggers still refuse changes; rerun is a no-op", () => {
    const path = dbPath();
    const { requestId, versionId } = makeV6(path);
    const before = dumpAll(path);
    assert.ok(!("quote_extraction_runs" in before));

    const backups: string[] = [];
    const db = openDatabase(path, { onBackup: (f) => backups.push(f) });
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(String.raw`\.v6-before-v${SCHEMA_VERSION}\.`));
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    db.close();

    const afterDump = dumpAll(path);
    for (const [table, rows] of Object.entries(before)) assert.equal(afterDump[table], rows, `${table} unchanged`);
    for (const t of ["quote_extraction_runs", "quote_extraction_reviews", "quote_version_supplier_refs"]) assert.equal(afterDump[t], "", `${t} added empty`);
    assert.deepEqual(dumpAll(backups[0]), before, "backup equals the pre-migration data");

    const check = new DatabaseSync(path);
    assert.deepEqual({ ...(check.prepare("SELECT buyer_type, buyer_person_name, buyer_company FROM procurement_requests WHERE id = ?").get(requestId) as object) }, {
      buyer_type: null,
      buyer_person_name: null,
      buyer_company: "Lumen Pte. Ltd.",
    }, "not inferred from the company name or the DEMO source");
    const v = check.prepare("SELECT raw_text, raw_text_sha256, request_snapshot FROM quote_versions WHERE id = ?").get(versionId) as { raw_text: string; raw_text_sha256: string; request_snapshot: string };
    assert.equal(v.raw_text, "报价编号：QT-DEMO-2026-118\r\n总价 人民币 11,760.00 元\t");
    assert.equal(JSON.parse(v.request_snapshot).snapshotVersion, 1);
    assert.throws(() => check.prepare("UPDATE quote_versions SET raw_text = 'x' WHERE id = ?").run(versionId), /immutable/);
    assert.throws(() => check.prepare("DELETE FROM quote_versions WHERE id = ?").run(versionId), /cannot be deleted/);
    assert.throws(() => check.prepare("UPDATE quote_series SET name = 'x'").run(), /immutable/);
    check.close();

    const again: string[] = [];
    openDatabase(path, { onBackup: (f) => again.push(f) }).close();
    assert.deepEqual(again, [], "no second backup, nothing re-applied");
    assert.deepEqual(dumpAll(path), afterDump);
  });

  test("a failing step rolls the whole migration back: still v6, no new columns, backup kept", () => {
    const path = dbPath();
    makeV6(path);
    // Sabotage: a table with the v7 name but the wrong columns, so creating its index fails mid-migration.
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE quote_extraction_runs (x INTEGER);");
    raw.close();
    const before = dumpAll(path);
    const backups: string[] = [];
    assert.throws(() => openDatabase(path, { onBackup: (f) => backups.push(f) }), /version_id/);
    assert.equal(backups.length, 1);
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    const columns = (check.prepare("SELECT name FROM pragma_table_info('procurement_requests')").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!columns.includes("buyer_type") && !columns.includes("buyer_person_name"));
    check.close();
    assert.deepEqual(dumpAll(path), before);
  });

  test("code older than the file refuses to open it (roll back file and code together)", () => {
    const path = dbPath();
    openDatabase(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => openDatabase(path), /newer than this code/);
  });
});
