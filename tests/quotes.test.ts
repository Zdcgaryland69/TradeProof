// Automated tests for schema v6: stable procurement item ids (edit / reorder / add / delete / restart,
// foreign and forged ids, outdated clients, no partial writes, v5 → v6 migration) and quote series with
// immutable versions (exact text, hash, request snapshot, revision / version conflicts, idempotent saves,
// supplements, validation, HTTP linkage checks, local-only guard, DB triggers, demo samples).

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { PROCUREMENT_ITEM_ID, emptyInput, type ProcurementInput, type ProcurementRecord } from "../src/lib/procurement.ts";
import { MAX_QUOTE_BODY_BYTES, QUOTE_LIMITS } from "../src/lib/quote-versions.ts";
import { SCHEMA_VERSION } from "../src/server/db/database.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { handleCreate, handleUpdate } from "../src/server/procurement/http.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput, type NormalizedProcurement } from "../src/server/procurement/validate.ts";
import { loadQuoteDemoSamples } from "../src/server/quotes/demo.ts";
import { handleAddVersion, handleCreateSeries, handleGetVersion, handleListQuotes } from "../src/server/quotes/http.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import type { NormalizedNewSeries, NormalizedNewVersion } from "../src/server/quotes/validate.ts";
import { validateNewSeries, validateNewVersion } from "../src/server/quotes/validate.ts";
import { addTestAccounts, testGate } from "./helpers/principals.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-quotes-test-"));
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
function stores(path = dbPath()) {
  const p = new ProcurementStore(path);
  const q = new QuoteStore(path);
  open.push(p, q);
  addTestAccounts(path);
  return { p, q, path };
}

const LOCAL = "http://127.0.0.1:3000";
const OPTS = { enabled: true, auth: testGate() };
function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${LOCAL}${path}`, {
    method,
    headers: { host: "127.0.0.1:3000", origin: LOCAL, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const item = (name: string, quantity = "10") => ({ id: null, name, quantity, unit: "pcs", material: "", specification: "", customization: "", notes: "" });

function input(overrides: Partial<ProcurementInput> = {}): ProcurementInput {
  return { ...emptyInput(), buyerType: "INDIVIDUAL", buyerPersonName: "Test Person", title: "Bottles", items: [item("Bottle A"), item("Bottle B"), item("Bottle C")], ...overrides };
}

function valid(body: unknown, mode: "create" | "update" = "create"): NormalizedProcurement {
  const r = validateProcurementInput(body, mode);
  assert.ok(r.ok, `expected valid, got ${JSON.stringify(!r.ok && r.errors)}`);
  return r.value;
}

/** Form text of a stored record (with item ids), as the edit page would send it. */
function formOf(record: ProcurementRecord): ProcurementInput {
  return {
    ...emptyInput(),
    buyerType: record.buyerType ?? "",
    buyerCompany: record.buyerCompany ?? "",
    buyerPersonName: record.buyerPersonName ?? "",
    title: record.title,
    items: record.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity === null ? "" : String(i.quantity), unit: i.unit ?? "", material: "", specification: "", customization: "", notes: "" })),
  };
}

const ids = (r: ProcurementRecord) => r.items.map((i) => i.id);
const names = (r: ProcurementRecord) => r.items.map((i) => i.name);

// ---------------------------------------------------------------- item ids

describe("stable item ids", () => {
  test("every line gets a server id; editing, reordering and restarting keep it; same names stay distinct", () => {
    const { p, path } = stores();
    const rec = p.create(valid(input({ items: [item("Bottle"), item("Bottle"), item("Lid")] })), "USER_INPUT");
    assert.equal(new Set(ids(rec)).size, 3);
    for (const id of ids(rec)) assert.match(id, PROCUREMENT_ITEM_ID);

    // Edit name / quantity of line 1 and swap lines 2 and 3.
    const form = formOf(rec);
    form.items[0] = { ...form.items[0], name: "Bottle (renamed)", quantity: "25" };
    form.items = [form.items[0], form.items[2], form.items[1]];
    const out = p.update(rec.id, 1, valid(form, "update"));
    assert.equal(out.status, "UPDATED");
    const after = (out as { record: ProcurementRecord }).record;
    assert.deepEqual(ids(after), [rec.items[0].id, rec.items[2].id, rec.items[1].id]);
    assert.deepEqual(names(after), ["Bottle (renamed)", "Lid", "Bottle"]);
    assert.deepEqual(after.items.map((i) => i.position), [1, 2, 3]);
    assert.equal(after.items[0].quantity, 25);

    p.close();
    const reopened = new ProcurementStore(path);
    open.push(reopened);
    assert.deepEqual(ids(reopened.get(rec.id)!), ids(after));
  });

  test("a new line gets a new id; a deleted line's id is never reused or accepted again", () => {
    const { p } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const removed = rec.items[1].id;
    const form = formOf(rec);
    form.items = [form.items[0], form.items[2], item("Bottle D")];
    const r2 = (p.update(rec.id, 1, valid(form, "update")) as { record: ProcurementRecord }).record;
    assert.deepEqual(ids(r2).slice(0, 2), [rec.items[0].id, rec.items[2].id]);
    assert.ok(!ids(rec).includes(r2.items[2].id), "new line has a fresh id");
    assert.ok(!ids(r2).includes(removed));

    // Sending the removed id back (e.g. from an old tab after overwrite) is refused; nothing changes.
    const sneaky = formOf(r2);
    sneaky.items.push({ ...item("Bottle B again"), id: removed });
    const out = p.update(rec.id, 2, valid(sneaky, "update"));
    assert.equal(out.status, "INVALID_ITEMS");
    assert.deepEqual((out as { errors: { field: string }[] }).errors.map((e) => e.field), ["items[3].id"]);
    assert.deepEqual(p.get(rec.id), r2);
  });

  test("an id from another request is refused and neither request changes", () => {
    const { p } = stores();
    const a = p.create(valid(input({ title: "A" })), "USER_INPUT");
    const b = p.create(valid(input({ title: "B" })), "USER_INPUT");
    const form = formOf(a);
    form.items[0] = { ...form.items[0], id: b.items[0].id, name: "stolen" };
    assert.equal(p.update(a.id, 1, valid(form, "update")).status, "INVALID_ITEMS");
    assert.deepEqual(p.get(a.id), a);
    assert.deepEqual(p.get(b.id), b);
  });

  test("validation: duplicate, malformed and create-time ids are refused", () => {
    const rec = { items: [{ id: `pri_${randomUUID()}` }] };
    const dup = validateProcurementInput({ ...input(), items: [{ ...item("x"), id: rec.items[0].id }, { ...item("y"), id: rec.items[0].id }] }, "update");
    assert.ok(!dup.ok && dup.errors.some((e) => e.field === "items[1].id"));
    const forged = validateProcurementInput({ ...input(), items: [{ ...item("x"), id: "pri_1; DROP TABLE" }] }, "update");
    assert.ok(!forged.ok && forged.errors[0].field === "items[0].id");
    const onCreate = validateProcurementInput({ ...input(), items: [{ ...item("x"), id: rec.items[0].id }] }, "create");
    assert.ok(!onCreate.ok && onCreate.errors[0].field === "items[0].id");
  });

  test("HTTP: a page loaded before v6 (items without `id`) gets 422 CLIENT_OUTDATED and nothing changes", async () => {
    const { p } = stores();
    const created = await (await handleCreate(req("POST", "/api/procurements", input()), p, OPTS)).json();
    const record = created.record as ProcurementRecord;
    const oldPage = { ...input({ title: "edited on an old page" }), items: input().items.map(({ id: _id, ...rest }) => rest), revision: 1 }; // eslint-disable-line @typescript-eslint/no-unused-vars
    const res = await handleUpdate(req("PUT", `/api/procurements/${record.id}`, oldPage), record.id, p, OPTS);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "CLIENT_OUTDATED");
    assert.match(body.message, /refresh/i);
    assert.deepEqual(p.get(record.id), record);
  });

  test("a stale revision changes nothing, including item lines (no partial write)", () => {
    const { p } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const tabA = formOf(rec);
    tabA.items[0] = { ...tabA.items[0], name: "A's edit" };
    assert.equal(p.update(rec.id, 1, valid(tabA, "update")).status, "UPDATED");
    const saved = p.get(rec.id)!;
    const tabB = formOf(rec);
    tabB.items = [tabB.items[2], { ...tabB.items[1], name: "B's edit" }, item("B's new line")];
    assert.equal(p.update(rec.id, 1, valid(tabB, "update")).status, "CONFLICT");
    assert.deepEqual(p.get(rec.id), saved);
  });

  test("a failure in the middle of writing items rolls everything back", () => {
    const { p } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const broken = valid(formOf(rec), "update");
    broken.items[0] = { ...broken.items[0], name: "changed first" };
    broken.items[2] = { ...broken.items[2], name: "x".repeat(300) }; // violates the DB CHECK
    assert.throws(() => p.update(rec.id, 1, broken));
    assert.deepEqual(p.get(rec.id), rec);
  });
});

describe("v5 → v6 migration", () => {
  /** A genuine v5 file: v5 item table (no id, PK request_id + position), no quote tables. */
  function makeV5(path: string) {
    const ps = new PaymentStore(path);
    new PaymentService({ store: ps, gateway: null, payeeMerchantId: null }).createTestRecord();
    ps.close();
    const p = new ProcurementStore(path);
    const a = p.create(valid(input({ title: "Same name twice", items: [item("Bottle"), item("Bottle")] })), "DEMO_SAMPLE");
    const b = p.create(valid(input({ title: "Other" })), "USER_INPUT");
    p.update(b.id, 1, valid({ ...formOf(b), title: "Other (edited)" }, "update"));
    p.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TABLE clarification_answers; DROP TABLE clarification_replies; DROP TABLE supplier_reply_quote_links; DROP TABLE supplier_replies;
      DROP TABLE quote_version_supplier_refs; DROP TABLE quote_extraction_reviews; DROP TABLE quote_extraction_runs;
      ALTER TABLE procurement_requests DROP COLUMN buyer_type; ALTER TABLE procurement_requests DROP COLUMN buyer_person_name;
      DROP TABLE quote_save_keys; DROP TABLE quote_versions; DROP TABLE quote_series;
      CREATE TABLE items_v5 (
        request_id TEXT NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 1), name TEXT NOT NULL, quantity INTEGER, unit TEXT, material TEXT,
        specification TEXT, customization TEXT, notes TEXT, PRIMARY KEY (request_id, position));
      INSERT INTO items_v5 SELECT request_id, position, name, quantity, unit, material, specification, customization, notes FROM procurement_request_items;
      DROP TABLE procurement_request_items; ALTER TABLE items_v5 RENAME TO procurement_request_items;
      PRAGMA user_version = 5;`);
    raw.close();
    return { a: a.id, b: b.id };
  }

  const dump = (db: DatabaseSync) => ({
    payments: JSON.stringify(db.prepare("SELECT * FROM sandbox_payment_records ORDER BY id").all()),
    events: JSON.stringify(db.prepare("SELECT * FROM sandbox_payment_events ORDER BY seq").all()),
    // v7 adds buyer_type / buyer_person_name (NULL for old rows); checked separately.
    requests: JSON.stringify(
      (db.prepare("SELECT * FROM procurement_requests ORDER BY id").all() as Record<string, unknown>[]).map((r) => {
        const { buyer_type: _type, buyer_person_name: _name, ...rest } = r;
        void _type;
        void _name;
        return rest;
      }),
    ),
    items: JSON.stringify(
      db.prepare("SELECT request_id, position, name, quantity, unit, material, specification, customization, notes FROM procurement_request_items ORDER BY request_id, position").all(),
    ),
  });

  test("backup first; every line gets exactly one id; all other data identical; reopening or re-running never regenerates ids", () => {
    const path = dbPath();
    const { a, b } = makeV5(path);
    const raw = new DatabaseSync(path, { readOnly: true });
    const before = dump(raw);
    raw.close();

    const backups: string[] = [];
    const p = new ProcurementStore(path, { onBackup: (f) => backups.push(f) });
    open.push(p);
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(String.raw`\.v5-before-v${SCHEMA_VERSION}\.`));
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.deepEqual(
      check.prepare("SELECT DISTINCT buyer_type, buyer_person_name FROM procurement_requests").all().map((r) => ({ ...r })),
      [{ buyer_type: null, buyer_person_name: null }],
      "old rows: buyer type not recorded (never inferred)",
    );
    assert.deepEqual(dump(check), before, "payments, events, requests (source, revision, timestamps) and item values unchanged");
    check.close();
    const backup = new DatabaseSync(backups[0], { readOnly: true });
    assert.deepEqual(dump(backup), before);
    backup.close();

    const ra = p.get(a)!;
    assert.equal(ra.source, "DEMO_SAMPLE");
    assert.equal(p.get(b)!.revision, 2);
    assert.deepEqual(names(ra), ["Bottle", "Bottle"]);
    assert.notEqual(ra.items[0].id, ra.items[1].id, "same-name lines get different ids");
    const firstIds = [...ids(ra), ...ids(p.get(b)!)];
    p.close();

    // Reopen: no new backup, same ids.
    const again: string[] = [];
    const p2 = new ProcurementStore(path, { onBackup: (f) => again.push(f) });
    open.push(p2);
    assert.deepEqual(again, []);
    assert.deepEqual([...ids(p2.get(a)!), ...ids(p2.get(b)!)], firstIds);
    p2.close();

    // Re-run the v6 step on an already-migrated file (version number set back): ids are kept.
    const rw = new DatabaseSync(path);
    rw.exec("PRAGMA user_version = 5;");
    rw.close();
    const p3 = new ProcurementStore(path);
    open.push(p3);
    assert.deepEqual([...ids(p3.get(a)!), ...ids(p3.get(b)!)], firstIds);
  });
});

// ---------------------------------------------------------------- quotes

const TEXT = "  报价单 QUOTATION\r\n\t材质：201 不锈钢\n<script>alert(1)</script><b>bold</b>\n\n最后一行 trailing spaces   \n";

function series(overrides: Partial<NormalizedNewSeries> = {}, version: Partial<NormalizedNewSeries["version"]> = {}): NormalizedNewSeries {
  return {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: 1,
    name: "QT-1",
    supplierDisplayName: "Example Supplier",
    ...overrides,
    version: { rawText: TEXT, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: "2026-10-15", revisionNote: null, ...version },
  };
}

function revision(expectedLatestVersionId: string, overrides: Partial<NormalizedNewVersion> = {}, version: Partial<NormalizedNewVersion["version"]> = {}): NormalizedNewVersion {
  return {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: 1,
    expectedLatestVersionId,
    ...overrides,
    version: { rawText: "Revised quote text\n", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: "supplier added freight", ...version },
  };
}

function created(outcome: ReturnType<QuoteStore["createSeries"]>) {
  assert.ok(outcome.status === "CREATED" || outcome.status === "REPLAYED", `expected a saved version, got ${outcome.status}`);
  return outcome;
}

describe("quote versions", () => {
  test("v1 stores the text exactly, its SHA-256 and a full request snapshot with item ids", () => {
    const { p, q } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const { series: s, version: v } = created(q.createSeries(rec.id, series()));
    assert.equal(v.versionNumber, 1);
    assert.equal(v.rawText, TEXT, "no trim / newline / HTML changes");
    assert.equal(v.rawTextSha256, createHash("sha256").update(TEXT, "utf8").digest("hex"));
    assert.equal(v.rawTextLength, [...TEXT].length);
    assert.equal(v.requestRevision, 1);
    assert.deepEqual(v.requestSnapshot.record, rec);
    assert.deepEqual(v.requestSnapshot.record.items.map((i) => i.id), ids(rec));
    assert.equal(s.supplierDisplayName, "Example Supplier");
    assert.equal(v.source, "TEST_FIXTURE");
  });

  test("v2 is a new row; v1 stays byte-identical; request edits never change existing snapshots", () => {
    const { p, q } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const first = created(q.createSeries(rec.id, series()));
    const v1Before = q.getVersion(rec.id, first.series.id, first.version.id);

    // Request changes (rename an item, add one) → revision 2.
    const form = formOf(rec);
    form.items[0] = { ...form.items[0], name: "Bottle A v2" };
    form.items.push(item("Bottle D"));
    p.update(rec.id, 1, valid(form, "update"));

    const stale = q.addVersion(rec.id, first.series.id, revision(first.version.id));
    assert.equal(stale.status, "REQUEST_CHANGED");
    assert.equal((stale as { currentRevision: number }).currentRevision, 2);
    assert.equal(q.listSeries(rec.id)[0].versions.length, 1, "nothing saved");

    const second = created(q.addVersion(rec.id, first.series.id, revision(first.version.id, { expectedRequestRevision: 2 })));
    assert.equal(second.version.versionNumber, 2);
    assert.equal(second.version.requestRevision, 2);
    assert.deepEqual(second.version.requestSnapshot.record.items.map((i) => i.name), ["Bottle A v2", "Bottle B", "Bottle C", "Bottle D"]);
    assert.equal(second.version.revisionNote, "supplier added freight");
    assert.deepEqual(q.getVersion(rec.id, first.series.id, first.version.id), v1Before);
    assert.equal(v1Before!.requestSnapshot.record.items[0].name, "Bottle A");
    assert.deepEqual(q.listSeries(rec.id)[0].versions.map((v) => v.versionNumber), [1, 2]);
  });

  test("two tabs revising the same base: the second gets VERSION_CONFLICT; nothing overwritten or reordered", () => {
    const path = dbPath();
    const { p, q } = stores(path);
    const tab2 = new QuoteStore(path); // a second connection, as from another request handler
    open.push(tab2);
    const rec = p.create(valid(input()), "USER_INPUT");
    const v1 = created(q.createSeries(rec.id, series())).version;
    const a = created(q.addVersion(rec.id, v1.seriesId, revision(v1.id, {}, { rawText: "from tab A" })));
    const b = tab2.addVersion(rec.id, v1.seriesId, revision(v1.id, {}, { rawText: "from tab B" }));
    assert.equal(b.status, "VERSION_CONFLICT");
    assert.equal((b as { latest: { id: string } }).latest.id, a.version.id);
    const list = q.listSeries(rec.id)[0].versions;
    assert.deepEqual(list.map((v) => [v.versionNumber, v.id]), [
      [1, v1.id],
      [2, a.version.id],
    ]);
    // Tab B re-bases on v2 deliberately → v3.
    assert.equal(created(tab2.addVersion(rec.id, v1.seriesId, revision(a.version.id, {}, { rawText: "from tab B" }))).version.versionNumber, 3);
  });

  test("idempotency: same key + same content → original result, even after the series and request moved on (lost response)", () => {
    const { p, q } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const v1 = created(q.createSeries(rec.id, series())).version;
    const save = revision(v1.id);
    const first = created(q.addVersion(rec.id, v1.seriesId, save));
    assert.equal(first.status, "CREATED");

    // Meanwhile: another version and a request edit. The retry must still return the original v2.
    created(q.addVersion(rec.id, v1.seriesId, revision(first.version.id, {}, { rawText: "v3" })));
    p.update(rec.id, 1, valid({ ...formOf(rec), title: "Bottles (edited)" }, "update")); // a real change: an unchanged save no longer bumps the revision
    const retry = q.addVersion(rec.id, v1.seriesId, structuredClone(save));
    assert.equal(retry.status, "REPLAYED");
    assert.equal((retry as { version: { id: string } }).version.id, first.version.id);
    assert.equal(q.listSeries(rec.id)[0].versions.length, 3, "no duplicate version");

    // Same key, different content → refused.
    assert.equal(q.addVersion(rec.id, v1.seriesId, { ...save, version: { ...save.version, rawText: "different" } }).status, "KEY_REUSED");
    // Same key on another endpoint / request → refused too.
    const other = p.create(valid(input({ title: "other" })), "USER_INPUT");
    assert.equal(q.createSeries(other.id, series({ idempotencyKey: save.idempotencyKey })).status, "KEY_REUSED");
    // Series creation replays as well.
    const s = series();
    const once = created(q.createSeries(other.id, s));
    const twice = created(q.createSeries(other.id, structuredClone(s)));
    assert.equal(twice.status, "REPLAYED");
    assert.equal(twice.series.id, once.series.id);
    assert.equal(q.listSeries(other.id).length, 1);
  });

  test("the same text may be saved for different requests (hash is not a unique key)", () => {
    const { p, q } = stores();
    const a = p.create(valid(input({ title: "A" })), "USER_INPUT");
    const b = p.create(valid(input({ title: "B" })), "USER_INPUT");
    const va = created(q.createSeries(a.id, series())).version;
    const vb = created(q.createSeries(b.id, series())).version;
    assert.equal(va.rawTextSha256, vb.rawTextSha256);
    assert.notEqual(va.id, vb.id);
  });

  test("supplements: must refer to a version of the same series; stored with the relation; never as version 1", () => {
    const { p, q, path } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const v1 = created(q.createSeries(rec.id, series())).version;
    const otherV1 = created(q.createSeries(rec.id, series({ name: "QT-2" }))).version;

    const foreign = q.addVersion(rec.id, v1.seriesId, revision(v1.id, {}, { contentKind: "SUPPLEMENT", supplementsVersionId: otherV1.id, rawText: "运费另计 RMB 300" }));
    assert.equal(foreign.status, "INVALID");
    const sup = created(q.addVersion(rec.id, v1.seriesId, revision(v1.id, {}, { contentKind: "SUPPLEMENT", supplementsVersionId: v1.id, rawText: "运费另计 RMB 300" })));
    assert.equal(sup.version.contentKind, "SUPPLEMENT");
    assert.equal(sup.version.supplementsVersionId, v1.id);
    assert.equal(sup.version.supplementsVersionNumber, 1);

    const firstAsSupplement = validateNewSeries({ ...series(), ...series().version, contentKind: "SUPPLEMENT", supplementsVersionId: v1.id, version: undefined });
    assert.ok(!firstAsSupplement.ok);
    const fullWithTarget = validateNewVersion({ ...revision(v1.id), ...revision(v1.id).version, version: undefined, supplementsVersionId: v1.id });
    assert.ok(!fullWithTarget.ok && fullWithTarget.errors.some((e) => e.field === "supplementsVersionId"));

    // The DB refuses a cross-series supplement even if the app check were skipped.
    const raw = new DatabaseSync(path);
    assert.throws(
      () =>
        raw
          .prepare(
            `INSERT INTO quote_versions (id, series_id, version_number, content_kind, supplements_version_id, raw_text, raw_text_sha256, source, request_revision, request_snapshot, saved_at)
             VALUES (?, ?, 99, 'SUPPLEMENT', ?, 'x', ?, 'TEST_FIXTURE', 1, '{}', 'now')`,
          )
          .run(`qv_${randomUUID()}`, v1.seriesId, otherV1.id, "0".repeat(64)),
      /same quote series/,
    );
    raw.close();
  });

  test("saved versions and series cannot be updated or deleted (DB triggers)", () => {
    const { p, q, path } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const v1 = created(q.createSeries(rec.id, series())).version;
    const raw = new DatabaseSync(path);
    assert.throws(() => raw.prepare("UPDATE quote_versions SET raw_text = 'tampered' WHERE id = ?").run(v1.id), /immutable/);
    assert.throws(() => raw.prepare("UPDATE quote_versions SET request_snapshot = '{}' WHERE id = ?").run(v1.id), /immutable/);
    assert.throws(() => raw.prepare("DELETE FROM quote_versions WHERE id = ?").run(v1.id), /cannot be deleted/);
    assert.throws(() => raw.prepare("UPDATE quote_series SET supplier_display_name = 'x' WHERE id = ?").run(v1.seriesId), /immutable/);
    raw.close();
    assert.equal(q.getVersion(rec.id, v1.seriesId, v1.id)!.rawText, TEXT);
  });
});

describe("quote validation", () => {
  const base = () => ({ idempotencyKey: randomUUID(), expectedRequestRevision: 1, name: "QT", rawText: "text", source: "USER_PASTE" });
  const fieldsOf = (r: ReturnType<typeof validateNewSeries>) => (r.ok ? [] : r.errors.map((e) => e.field));

  test("raw text: kept verbatim; blank, too long, control characters and broken surrogates refused", () => {
    const ok = validateNewSeries({ ...base(), rawText: "  a\r\n b \t" });
    assert.ok(ok.ok && ok.value.version.rawText === "  a\r\n b \t");
    for (const bad of ["", "   \n\t  ", "x".repeat(QUOTE_LIMITS.rawText + 1), "nul\u0000here", "bell\u0007", "half \ud800 surrogate", 42]) {
      assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), rawText: bad })), ["rawText"], JSON.stringify(String(bad).slice(0, 20)));
    }
    // Exactly at the limit (counted in characters, CJK included) is fine.
    assert.ok(validateNewSeries({ ...base(), rawText: "报".repeat(QUOTE_LIMITS.rawText) }).ok);
  });

  test("server-owned fields cannot be sent; source must be explicit; titles never decide the source", () => {
    for (const key of ["versionNumber", "savedAt", "rawTextSha256", "requestSnapshot", "requestId", "seriesId", "id"]) {
      assert.ok(fieldsOf(validateNewSeries({ ...base(), [key]: "x" })).includes(key), key);
    }
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), source: undefined })), ["source"]);
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), source: "ADMIN" })), ["source"]);
    const demoTitle = validateNewSeries({ ...base(), name: "[SYNTHETIC / DEMO] demo quote", rawText: "demo demo" });
    assert.ok(demoTitle.ok && demoTitle.value.version.source === "USER_PASTE");
  });

  test("metadata limits, dates, keys and revisions", () => {
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), name: "   " })), ["name"]);
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), name: "a\nb" })), ["name"]);
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), revisionNote: "x".repeat(QUOTE_LIMITS.revisionNote + 1) })), ["revisionNote"]);
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), supplierQuoteDate: "2026-02-30" })), ["supplierQuoteDate"]);
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), idempotencyKey: "abc" })), ["idempotencyKey"]);
    assert.deepEqual(fieldsOf(validateNewSeries({ ...base(), expectedRequestRevision: "1" })), ["expectedRequestRevision"]);
    assert.ok(!validateNewVersion({ ...base(), name: undefined, expectedLatestVersionId: "qv_bad" }).ok);
  });
});

describe("quote HTTP layer", () => {
  async function setup() {
    const { p, q } = stores();
    const rec = p.create(valid(input()), "USER_INPUT");
    const body = { idempotencyKey: randomUUID(), expectedRequestRevision: 1, name: "QT", supplierDisplayName: "S", rawText: TEXT, source: "USER_PASTE", contentKind: "FULL_QUOTE" };
    const res = await handleCreateSeries(req("POST", `/api/procurements/${rec.id}/quotes`, body), rec.id, q, OPTS);
    assert.equal(res.status, 201);
    const data = await res.json();
    return { p, q, rec, body, series: data.series, version: data.version };
  }

  test("201 then 200 REPLAYED for a repeated request; 409 codes keep nothing; list + get", async () => {
    const { p, q, rec, body, series: s, version: v1 } = await setup();
    const again = await handleCreateSeries(req("POST", `/api/procurements/${rec.id}/quotes`, body), rec.id, q, OPTS);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).code, "REPLAYED");

    const revBody = { idempotencyKey: randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: v1.id, rawText: "v2", source: "USER_PASTE" };
    const v2 = await handleAddVersion(req("POST", `/x`, revBody), rec.id, s.id, q, OPTS);
    assert.equal(v2.status, 201);
    const conflict = await handleAddVersion(req("POST", `/x`, { ...revBody, idempotencyKey: randomUUID() }), rec.id, s.id, q, OPTS);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "VERSION_CONFLICT");

    p.update(rec.id, 1, valid({ ...formOf(rec), title: "Bottles (edited)" }, "update")); // a real change: an unchanged save no longer bumps the revision
    const latest = q.listSeries(rec.id)[0].versions.at(-1)!;
    const changed = await handleAddVersion(req("POST", `/x`, { ...revBody, idempotencyKey: randomUUID(), expectedLatestVersionId: latest.id }), rec.id, s.id, q, OPTS);
    assert.equal(changed.status, 409);
    const changedBody = await changed.json();
    assert.equal(changedBody.code, "REQUEST_CHANGED");
    assert.equal(changedBody.currentRevision, 2);

    const list = await (await handleListQuotes(req("GET", "/x"), rec.id, q, OPTS)).json();
    assert.deepEqual(list.series[0].versions.map((v: { versionNumber: number }) => v.versionNumber), [1, 2]);
    const got = await handleGetVersion(req("GET", "/x"), rec.id, s.id, v1.id, q, OPTS);
    assert.equal((await got.json()).version.rawText, TEXT);
  });

  test("forged linkage: another request's series / version → 404; foreign base or supplement → 422", async () => {
    const one = await setup();
    const { p, q } = one;
    const other = p.create(valid(input({ title: "other" })), "USER_INPUT");
    const otherSeries = created(q.createSeries(other.id, series())).series;
    assert.equal((await handleGetVersion(req("GET", "/x"), other.id, one.series.id, one.version.id, q, OPTS)).status, 404);
    assert.equal((await handleGetVersion(req("GET", "/x"), one.rec.id, otherSeries.id, one.version.id, q, OPTS)).status, 404);
    const body = { idempotencyKey: randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: one.version.id, rawText: "x", source: "USER_PASTE" };
    assert.equal((await handleAddVersion(req("POST", "/x", body), other.id, one.series.id, q, OPTS)).status, 404);
    const foreignBase = await handleAddVersion(req("POST", "/x", { ...body, expectedLatestVersionId: otherSeries.versions[0].id }), one.rec.id, one.series.id, q, OPTS);
    assert.equal(foreignBase.status, 422);
    const foreignSup = await handleAddVersion(
      req("POST", "/x", { ...body, contentKind: "SUPPLEMENT", supplementsVersionId: otherSeries.versions[0].id }),
      one.rec.id,
      one.series.id,
      q,
      OPTS,
    );
    assert.equal(foreignSup.status, 422);
    assert.equal(q.listSeries(one.rec.id)[0].versions.length, 1);
  });

  test("body over the limit → 413; production → 404 without opening the DB; non-loopback → 403", async () => {
    const { q, rec } = await setup();
    const huge = JSON.stringify({ rawText: "x".repeat(MAX_QUOTE_BODY_BYTES) });
    assert.equal((await handleCreateSeries(req("POST", "/x", huge), rec.id, q, OPTS)).status, 413);

    const path = dbPath();
    let opened = 0;
    const factory = () => {
      opened++;
      return new QuoteStore(path);
    };
    const off = { enabled: false, auth: testGate() };
    const id = rec.id;
    assert.equal((await handleListQuotes(req("GET", "/x"), id, factory, off)).status, 404);
    assert.equal((await handleCreateSeries(req("POST", "/x", {}), id, factory, off)).status, 404);
    assert.equal((await handleAddVersion(req("POST", "/x", {}), id, `qs_${randomUUID()}`, factory, off)).status, 404);
    assert.equal((await handleGetVersion(req("GET", "/x"), id, `qs_${randomUUID()}`, `qv_${randomUUID()}`, factory, off)).status, 404);
    assert.equal((await handleListQuotes(req("GET", "/x", undefined, { host: "evil.example" }), id, factory, OPTS)).status, 403);
    assert.equal((await handleCreateSeries(req("POST", "/x", {}, { origin: "https://evil.example" }), id, factory, OPTS)).status, 403);
    assert.equal(opened, 0);
    assert.equal(existsSync(path), false);
  });
});

describe("quote demo samples (SYNTHETIC)", () => {
  test("the three sample quotes load with their banner; text equals the file apart from line endings; files untouched", () => {
    const before = ["zh", "en", "revised"].map((k) => readFileSync(`samples/synthetic/supplier-quote-${k}.synthetic.md`));
    const samples = loadQuoteDemoSamples();
    assert.deepEqual(samples.map((s) => s.key), ["zh", "en", "revised"]);
    for (const s of samples) {
      assert.ok(s.text.startsWith("> SYNTHETIC / DEMO"));
      assert.equal(s.text, readFileSync(s.sourceNote, "utf8").replace(/\r\n/g, "\n"));
      assert.match(s.name, /SYNTHETIC \/ DEMO/);
    }
    assert.match(samples[0].text, /201 不锈钢/);
    assert.match(samples[0].text, /480 个/);
    assert.match(samples[0].text, /50% 定金/);
    // 3 Nov: the revised sample order (20 pcs, USD 68.00, 100 % before shipment).
    assert.match(samples[2].text, /304 不锈钢/);
    assert.match(samples[2].text, /美元 68.00/);
    assert.match(samples[2].text, /100% 定金（预付）/);
    ["zh", "en", "revised"].forEach((k, i) => assert.deepEqual(readFileSync(`samples/synthetic/supplier-quote-${k}.synthetic.md`), before[i]));
  });
});
