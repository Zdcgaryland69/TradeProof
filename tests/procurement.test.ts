// Automated tests for procurement drafts: server-side validation, transactional storage,
// optimistic concurrency (revision), HTTP layer + local-only guard, schema v4 migration, demo sample.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { MAX_BODY_BYTES, MAX_ITEMS, emptyInput, recordToInput, shortProcurementId, type ProcurementInput } from "../src/lib/procurement.ts";
import { SCHEMA_VERSION } from "../src/server/db/database.ts";
import { PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { demoInputFromSample, loadDemoInput } from "../src/server/procurement/demo.ts";
import { handleCreate, handleGet, handleList, handleUpdate } from "../src/server/procurement/http.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput, type NormalizedProcurement } from "../src/server/procurement/validate.ts";
import { addTestAccounts, ALL_REQUESTS, testGate } from "./helpers/principals.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-procurement-test-"));
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

function dbPath(): string {
  return join(dir, `app-${++counter}.sqlite`);
}
function store(path = dbPath()): ProcurementStore {
  const s = new ProcurementStore(path);
  open.push(s);
  addTestAccounts(path);
  return s;
}

/** Smallest valid buyer (schema v7: buyer type is required on create). */
const BUYER = { buyerType: "INDIVIDUAL", buyerPersonName: "Test Person" };

function input(overrides: Partial<ProcurementInput> = {}): ProcurementInput {
  return {
    ...emptyInput(),
    buyerType: "BUSINESS",
    buyerCompany: "Test Buyer Pte. Ltd.",
    title: "500 insulated bottles",
    items: [{ id: null, name: "Bottle", quantity: "500", unit: "pcs", material: "304 stainless steel", specification: "500 ml", customization: "Laser logo", notes: "" }],
    ...overrides,
  };
}

/** PUT body for `record`: form fields from input(overrides), item lines carrying the stored ids by position. */
function putBody(record: { items: { id: string }[] }, overrides: Partial<ProcurementInput> = {}) {
  const fields = input(overrides);
  return { ...fields, items: fields.items.map((item, i) => ({ ...item, id: record.items[i]?.id ?? null })) };
}

function valid(body: unknown): NormalizedProcurement {
  const r = validateProcurementInput(body);
  assert.ok(r.ok, `expected valid, got ${JSON.stringify(!r.ok && r.errors)}`);
  return r.value;
}

function fieldsOf(body: unknown): string[] {
  const r = validateProcurementInput(body);
  assert.equal(r.ok, false, "expected validation to fail");
  return r.ok ? [] : r.errors.map((e) => e.field);
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

describe("server-side validation", () => {
  test("minimal draft: title + buyer type and name + one named item; everything else may be empty", () => {
    const v = valid({ ...BUYER, title: "  Bottles  ", items: [{ name: "Bottle" }] });
    assert.equal(v.title, "Bottles");
    assert.equal(v.items[0].quantity, null);
    assert.equal(v.budgetMaxMinor, null);
    assert.equal(v.supplierName, null);
  });

  test("title and at least one item with a name are required", () => {
    assert.deepEqual(fieldsOf({ ...BUYER, title: "", items: [{ name: "x" }] }), ["title"]);
    assert.deepEqual(fieldsOf({ ...BUYER, title: "t", items: [] }), ["items"]);
    assert.deepEqual(fieldsOf({ ...BUYER, title: "t" }), ["items"]);
    assert.deepEqual(fieldsOf({ ...BUYER, title: "t", items: [{ name: "  ", quantity: "5" }] }), ["items[0].name"]);
  });

  test("quantity: positive whole numbers only; empty stays null", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e3", "+5", "0x10", " 5 5", 2.5, 0, -3, Infinity, true]) {
      assert.deepEqual(fieldsOf(input({ items: [{ ...input().items[0], quantity: bad as string }] })), ["items[0].quantity"], `quantity ${String(bad)}`);
    }
    assert.equal(valid(input({ items: [{ ...input().items[0], quantity: "" }] })).items[0].quantity, null);
    assert.equal(valid(input({ items: [{ ...input().items[0], quantity: " 500 " }] })).items[0].quantity, 500);
    assert.equal(valid({ ...BUYER, title: "t", items: [{ name: "x", quantity: 7 }] }).items[0].quantity, 7);
    assert.deepEqual(fieldsOf(input({ items: [{ ...input().items[0], quantity: "100000001" }] })), ["items[0].quantity"]);
  });

  test("budget: decimal text, ≤ 2 decimals, not negative → integer minor units; empty ≠ 0", () => {
    const ok = (s: string) => valid(input({ budgetCurrency: "USD", budgetMax: s })).budgetMaxMinor;
    assert.equal(ok("1800"), 180000);
    assert.equal(ok("1800.5"), 180050);
    assert.equal(ok("0.1"), 10);
    assert.equal(ok("0.29"), 29); // 0.29 * 100 = 28.999999999999996 in floating point
    assert.equal(ok("0"), 0);
    assert.equal(ok("999999999999.99"), 99_999_999_999_999);
    assert.equal(valid(input({ budgetCurrency: "USD", budgetMax: "" })).budgetMaxMinor, null);
    for (const bad of ["-1", "-0.01", "1.234", "1e3", "abc", "1,800.00", "NaN", "Infinity", ".5", "1.", "1000000000000"]) {
      assert.deepEqual(fieldsOf(input({ budgetCurrency: "USD", budgetMax: bad })), ["budgetMax"], `budget ${bad}`);
    }
    assert.deepEqual(fieldsOf({ ...input(), budgetCurrency: "USD", budgetMax: 1800 }), ["budgetMax"], "numbers are refused (no floats)");
  });

  test("currency limited to USD / SGD / CNY; a budget cap needs a currency", () => {
    for (const c of ["USD", "SGD", "CNY"]) assert.equal(valid(input({ budgetCurrency: c })).budgetCurrency, c);
    assert.deepEqual(fieldsOf(input({ budgetCurrency: "EUR" })), ["budgetCurrency"]);
    assert.deepEqual(fieldsOf(input({ budgetCurrency: "usd" })), ["budgetCurrency"]);
    assert.deepEqual(fieldsOf(input({ budgetMax: "100" })), ["budgetCurrency"]);
  });

  test("dates: real YYYY-MM-DD calendar days within range, kept as text", () => {
    assert.equal(valid(input({ requiredShipDate: "2026-12-10" })).requiredShipDate, "2026-12-10");
    assert.equal(valid(input({ expectedDeliveryDate: "2028-02-29" })).expectedDeliveryDate, "2028-02-29");
    for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026/12/10", "10-12-2026", "2026-1-5", "2026-12-10T00:00:00Z", "1999-12-31", "2101-01-01"]) {
      assert.deepEqual(fieldsOf(input({ requiredShipDate: bad })), ["requiredShipDate"], `date ${bad}`);
    }
  });

  test("length limits count characters (incl. Chinese) and item count is capped", () => {
    assert.ok(valid(input({ title: "瓶".repeat(200) })));
    assert.deepEqual(fieldsOf(input({ title: "瓶".repeat(201) })), ["title"]);
    assert.ok(valid(input({ additionalRequirements: "a".repeat(4000) })));
    assert.deepEqual(fieldsOf(input({ additionalRequirements: "a".repeat(4001) })), ["additionalRequirements"]);
    assert.deepEqual(fieldsOf(input({ items: [{ ...input().items[0], specification: "x".repeat(2001) }] })), ["items[0].specification"]);
    const many = Array.from({ length: MAX_ITEMS + 1 }, () => ({ name: "x" }));
    assert.deepEqual(fieldsOf({ ...BUYER, title: "t", items: many }), ["items"]);
    assert.equal(valid({ ...BUYER, title: "t", items: many.slice(0, MAX_ITEMS) }).items.length, MAX_ITEMS);
  });

  test("status / ids / timestamps cannot be set by the client; control characters and multi-line titles refused", () => {
    assert.deepEqual(fieldsOf({ ...input(), status: "APPROVED" }), ["status"]);
    assert.deepEqual(fieldsOf({ ...input(), id: "pr_x", createdAt: "2020-01-01" }), ["id", "createdAt"]);
    assert.deepEqual(fieldsOf({ ...input(), items: [{ name: "x", price: "1" }] }), ["items[0].price"]);
    assert.deepEqual(fieldsOf(input({ title: "a\u0000b" })), ["title"]);
    assert.deepEqual(fieldsOf(input({ title: "line1\nline2" })), ["title"]);
    assert.equal(valid(input({ paymentTerms: "30% deposit\r\n70% before shipment" })).paymentTerms, "30% deposit\n70% before shipment");
  });

  test("HTML in input is stored as plain text, unchanged", () => {
    assert.equal(valid(input({ title: '<script>alert("x")</script>' })).title, '<script>alert("x")</script>');
  });
});

describe("storage", () => {
  test("create → read: request and items persisted with DRAFT, revision 1, UTC timestamps", () => {
    const s = store();
    const rec = s.create(valid(input({ budgetCurrency: "CNY", budgetMax: "11760.00", items: [...input().items, { ...input().items[0], name: "Gift box", quantity: "" }] })), "USER_INPUT");
    assert.match(rec.id, /^pr_[0-9a-f-]{36}$/);
    assert.equal(rec.status, "DRAFT");
    assert.equal(rec.revision, 1);
    assert.match(rec.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const back = s.get(rec.id)!;
    assert.deepEqual(back, rec);
    assert.equal(back.budgetMaxMinor, 1176000);
    assert.equal(back.budgetMax, "11760.00");
    assert.deepEqual(back.items.map((i) => [i.position, i.name, i.quantity]), [
      [1, "Bottle", 500],
      [2, "Gift box", null],
    ]);
    assert.equal(s.list(100, ALL_REQUESTS).length, 1);
    assert.equal(s.list(100, ALL_REQUESTS)[0].itemCount, 2);
  });

  test("empty and zero stay different after a round trip", () => {
    const s = store();
    const none = s.create(valid(input({ budgetCurrency: "USD", budgetMax: "", items: [{ ...input().items[0], quantity: "" }] })), "USER_INPUT");
    const zero = s.create(valid(input({ budgetCurrency: "USD", budgetMax: "0" })), "USER_INPUT");
    assert.equal(s.get(none.id)!.budgetMaxMinor, null);
    assert.equal(s.get(none.id)!.items[0].quantity, null);
    assert.equal(s.get(zero.id)!.budgetMaxMinor, 0);
    assert.equal(s.get(zero.id)!.budgetMax, "0.00");
    assert.equal(recordToInput(s.get(none.id)!).budgetMax, "");
    assert.equal(recordToInput(s.get(zero.id)!).budgetMax, "0.00");
  });

  test("edit replaces fields and items, bumps revision and updated_at only", () => {
    let t = Date.parse("2026-10-22T08:00:00.000Z");
    const s = new ProcurementStore(dbPath(), { now: () => new Date((t += 1000)) });
    open.push(s);
    const rec = s.create(valid(input({ items: [{ ...input().items[0] }, { ...input().items[0], name: "Lid" }] })), "USER_INPUT");
    const out = s.update(rec.id, 1, valid(input({ title: "Edited", items: [{ ...input().items[0], material: "316 stainless steel" }] })));
    assert.equal(out.status, "UPDATED");
    const now = s.get(rec.id)!;
    assert.equal(now.title, "Edited");
    assert.equal(now.revision, 2);
    assert.equal(now.items.length, 1);
    assert.equal(now.items[0].material, "316 stainless steel");
    assert.equal(now.createdAt, rec.createdAt);
    assert.ok(now.updatedAt > rec.updatedAt);
  });

  test("a failing item write rolls back the whole save (create and update)", () => {
    const path = dbPath();
    const s = store(path);
    const good = valid(input());
    // Bypass validation to hit the DB CHECK on the 2nd item (simulates an app-layer bug / disk error).
    const broken: NormalizedProcurement = { ...good, title: "Broken", items: [good.items[0], { ...good.items[0], name: "x".repeat(201) }] };
    assert.throws(() => s.create(broken, "USER_INPUT"));
    assert.equal(s.list(100, ALL_REQUESTS).length, 0, "no request row without its items");
    const raw = new DatabaseSync(path, { readOnly: true });
    assert.equal((raw.prepare("SELECT count(*) AS n FROM procurement_request_items").get() as { n: number }).n, 0);
    raw.close();

    const rec = s.create(good, "USER_INPUT");
    assert.throws(() => s.update(rec.id, 1, broken));
    const after = s.get(rec.id)!;
    assert.equal(after.title, good.title);
    assert.equal(after.revision, 1);
    assert.equal(after.items.length, 1);
  });

  test("the DB itself refuses non-DRAFT status, negative budget and zero quantity", () => {
    const path = dbPath();
    const s = store(path);
    const rec = s.create(valid(input()), "USER_INPUT");
    const raw = new DatabaseSync(path);
    assert.throws(() => raw.prepare("UPDATE procurement_requests SET status = 'APPROVED' WHERE id = ?").run(rec.id));
    assert.throws(() => raw.prepare("UPDATE procurement_requests SET budget_currency = 'USD', budget_max_minor = -1 WHERE id = ?").run(rec.id));
    assert.throws(() => raw.prepare("UPDATE procurement_request_items SET quantity = 0 WHERE request_id = ?").run(rec.id));
    assert.throws(() => raw.prepare("UPDATE procurement_request_items SET quantity = 1.5 WHERE request_id = ?").run(rec.id));
    raw.close();
  });
});

describe("edit conflicts (revision)", () => {
  test("two clients edit the same draft: the stale save is refused and the newer content kept", () => {
    const s = store();
    const rec = s.create(valid(input()), "USER_INPUT");
    const a = s.update(rec.id, 1, valid(input({ title: "Client A" })));
    assert.equal(a.status, "UPDATED");
    const b = s.update(rec.id, 1, valid(input({ title: "Client B (stale)" })));
    assert.equal(b.status, "CONFLICT");
    assert.ok(b.status === "CONFLICT" && b.current.title === "Client A" && b.current.revision === 2);
    assert.equal(s.get(rec.id)!.title, "Client A");
    assert.equal(s.get(rec.id)!.revision, 2);
    // After seeing the conflict, B may explicitly save on top of revision 2.
    assert.equal(s.update(rec.id, 2, valid(input({ title: "Client B (on purpose)" }))).status, "UPDATED");
    assert.equal(s.get(rec.id)!.revision, 3);
  });

  test("two DB connections (two server processes) racing on the same revision: exactly one wins", () => {
    const path = dbPath();
    const s1 = store(path);
    const s2 = store(path);
    const rec = s1.create(valid(input()), "USER_INPUT");
    const r1 = s1.update(rec.id, 1, valid(input({ title: "one" })));
    const r2 = s2.update(rec.id, 1, valid(input({ title: "two" })));
    assert.deepEqual([r1.status, r2.status], ["UPDATED", "CONFLICT"]);
    assert.equal(s2.get(rec.id)!.title, "one");
  });

  test("HTTP: stale PUT → 409 with the current version, nothing overwritten", async () => {
    const s = store();
    const created = await (await handleCreate(req("POST", "/api/procurements", input()), s, OPTS)).json();
    const id = created.record.id as string;
    const first = await handleUpdate(req("PUT", `/api/procurements/${id}`, { ...putBody(created.record, { title: "Tab A" }), revision: 1 }), id, s, OPTS);
    assert.equal(first.status, 200);
    const stale = await handleUpdate(req("PUT", `/api/procurements/${id}`, { ...putBody(created.record, { title: "Tab B" }), revision: 1 }), id, s, OPTS);
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.code, "CONFLICT");
    assert.equal(body.current.title, "Tab A");
    assert.equal(body.current.revision, 2);
    assert.equal(s.get(id)!.title, "Tab A");
  });
});

describe("HTTP layer", () => {
  test("create 201 → get 200 → list → update 200", async () => {
    const s = store();
    const res = await handleCreate(req("POST", "/api/procurements", input()), s, OPTS);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const { record } = await res.json();
    assert.equal(record.status, "DRAFT");
    const got = await handleGet(req("GET", `/api/procurements/${record.id}`), record.id, s, OPTS);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).record.items[0].name, "Bottle");
    const list = await (await handleList(req("GET", "/api/procurements"), s, OPTS)).json();
    assert.equal(list.requests.length, 1);
    const upd = await handleUpdate(req("PUT", `/api/procurements/${record.id}`, { ...putBody(record, { supplierName: "Demo Supplier" }), revision: 1 }), record.id, s, OPTS);
    assert.equal(upd.status, 200);
    assert.equal((await upd.json()).record.supplierName, "Demo Supplier");
  });

  test("invalid input → 422 with field errors, nothing stored", async () => {
    const s = store();
    const res = await handleCreate(
      req("POST", "/api/procurements", { ...input({ budgetCurrency: "USD", budgetMax: "-5", requiredShipDate: "2026-02-30" }), status: "PAID", items: [{ name: "x", quantity: "0" }] }),
      s,
      OPTS,
    );
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.deepEqual(body.errors.map((e: { field: string }) => e.field).sort(), ["budgetMax", "items[0].quantity", "requiredShipDate", "status"]);
    assert.equal(s.list(100, ALL_REQUESTS).length, 0);
  });

  test("PUT without a revision → 422; unknown / malformed id → 404", async () => {
    const s = store();
    const rec = s.create(valid(input()), "USER_INPUT");
    const noRev = await handleUpdate(req("PUT", `/api/procurements/${rec.id}`, putBody(rec)), rec.id, s, OPTS);
    assert.equal(noRev.status, 422);
    assert.equal((await noRev.json()).errors[0].field, "revision");
    for (const id of ["pr_00000000-0000-0000-0000-000000000000", "../etc", "tp_x"]) {
      assert.equal((await handleGet(req("GET", `/api/procurements/x`), id, s, OPTS)).status, 404);
      assert.equal((await handleUpdate(req("PUT", `/api/procurements/x`, { ...putBody({ items: [] }), revision: 1 }), id, s, OPTS)).status, 404);
    }
  });

  test("body limits: > MAX_BODY_BYTES → 413, wrong content type → 415, broken JSON → 400", async () => {
    const s = store();
    const huge = JSON.stringify({ ...input(), additionalRequirements: "x".repeat(MAX_BODY_BYTES) });
    assert.equal((await handleCreate(req("POST", "/api/procurements", huge), s, OPTS)).status, 413);
    // Same check when no Content-Length is declared (streamed body).
    const streamed = new Request(`${LOCAL}/api/procurements`, {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: LOCAL, "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(huge));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    assert.equal((await handleCreate(streamed, s, OPTS)).status, 413);
    assert.equal((await handleCreate(req("POST", "/api/procurements", JSON.stringify(input()), { "content-type": "text/plain" }), s, OPTS)).status, 415);
    assert.equal((await handleCreate(req("POST", "/api/procurements", "{not json"), s, OPTS)).status, 400);
    assert.equal(s.list(100, ALL_REQUESTS).length, 0);
  });
});

describe("local-only guard on the procurement API", () => {
  test("production → 404 and the DB file is never created; non-loopback / cross-origin → 403", async () => {
    const path = dbPath();
    let opened = 0;
    const factory = () => {
      opened++;
      return store(path);
    };
    const off = { enabled: false, auth: testGate() };
    assert.equal((await handleList(req("GET", "/api/procurements"), factory, off)).status, 404);
    assert.equal((await handleCreate(req("POST", "/api/procurements", input()), factory, off)).status, 404);
    assert.equal((await handleGet(req("GET", "/x"), "pr_00000000-0000-0000-0000-000000000000", factory, off)).status, 404);
    assert.equal((await handleUpdate(req("PUT", "/x", input()), "pr_00000000-0000-0000-0000-000000000000", factory, off)).status, 404);
    assert.equal(opened, 0);
    assert.equal(existsSync(path), false);

    assert.equal((await handleList(req("GET", "/api/procurements", undefined, { host: "evil.example" }), factory, OPTS)).status, 403);
    assert.equal((await handleCreate(req("POST", "/api/procurements", input(), { origin: "https://evil.example" }), factory, OPTS)).status, 403);
    const noOrigin = new Request(`${LOCAL}/api/procurements`, { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json" }, body: "{}" });
    assert.equal((await handleCreate(noOrigin, factory, OPTS)).status, 403);
    assert.equal((await handleCreate(req("POST", "/api/procurements", input(), { host: "192.168.1.5:3000", origin: "http://192.168.1.5:3000" }), factory, OPTS)).status, 403);
    assert.equal(opened, 0);
    assert.equal(existsSync(path), false);
  });
});

describe("schema v4 migration keeps payment records", () => {
  test("v3 payment DB → v4: backup written first, payment rows byte-identical, procurement tables added", () => {
    const path = dbPath();
    // Build a genuine v3 file: payment record, then remove the v4 tables and set user_version back.
    const ps = new PaymentStore(path);
    const svc = new PaymentService({ store: ps, gateway: null, payeeMerchantId: null });
    const payId = svc.createTestRecord().record!.id;
    ps.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE procurement_request_items; DROP TABLE procurement_requests; PRAGMA user_version = 3;");
    const before = JSON.stringify(raw.prepare("SELECT * FROM sandbox_payment_records ORDER BY id").all());
    const eventsBefore = JSON.stringify(raw.prepare("SELECT * FROM sandbox_payment_events ORDER BY seq").all());
    raw.close();

    const backups: string[] = [];
    const s = new ProcurementStore(path, { onBackup: (f) => backups.push(f) });
    open.push(s);
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(String.raw`backups[\\/].+\.v3-before-v${SCHEMA_VERSION}\..+\.sqlite$`));

    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal(JSON.stringify(check.prepare("SELECT * FROM sandbox_payment_records ORDER BY id").all()), before);
    assert.equal(JSON.stringify(check.prepare("SELECT * FROM sandbox_payment_events ORDER BY seq").all()), eventsBefore);
    check.close();

    const backup = new DatabaseSync(backups[0], { readOnly: true });
    assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    assert.equal(JSON.stringify(backup.prepare("SELECT * FROM sandbox_payment_records ORDER BY id").all()), before);
    backup.close();

    // Both modules keep working on the migrated file.
    assert.ok(s.create(valid(input()), "USER_INPUT"));
    const ps2 = new PaymentStore(path);
    open.push(ps2);
    assert.equal(ps2.get(payId)!.status, "NEW");
  });

  test("opening an up-to-date DB writes no further backup; a fresh DB needs none", () => {
    const path = dbPath();
    const backups: string[] = [];
    store(path).close();
    const s = new ProcurementStore(path, { onBackup: (f) => backups.push(f) });
    open.push(s);
    assert.deepEqual(backups, []);
    const backupDir = join(dir, "backups");
    const name = path.slice(dir.length + 1);
    assert.equal(existsSync(backupDir) && readdirSync(backupDir).some((f) => f.startsWith(`${name}.`)), false);
  });
});

describe("demo sample (SYNTHETIC)", () => {
  test("Load demo maps the existing synthetic request and passes server validation", () => {
    const demo = loadDemoInput();
    assert.ok(demo, "sample file readable");
    assert.match(demo.title, /SYNTHETIC \/ DEMO/);
    assert.match(demo.additionalRequirements, /SYNTHETIC \/ DEMO DATA/);
    const v = valid(demo);
    assert.equal(v.budgetCurrency, "USD");
    assert.equal(v.budgetMaxMinor, 180000);
    assert.equal(v.requiredShipDate, "2026-12-10");
    assert.equal(v.paymentTerms, "30% deposit, 70% before shipment");
    assert.equal(v.supplierName, null, "sample names no supplier → TBD");
    assert.equal(v.items[0].quantity, 500);
    assert.equal(v.items[0].unit, "pcs");
    assert.equal(v.items[0].material, "304 stainless steel");
    assert.match(v.items[0].customization!, /Laser engraving, 1 colour/);
    assert.match(v.additionalRequirements!, /USD 3\.60 \/ pcs/);
  });

  test("the original sample and its six seeded discrepancies are unchanged", () => {
    const request = JSON.parse(readFileSync("samples/synthetic/purchase-request.synthetic.json", "utf8"));
    const findings = JSON.parse(readFileSync("samples/synthetic/expected-discrepancies.synthetic.json", "utf8")).findings;
    assert.equal(findings.length, 6);
    assert.deepEqual(
      findings.map((f: { field: string }) => f.field),
      ["material", "logo", "quantity", "currency_and_amount", "lead_time", "payment_terms"],
    );
    assert.equal(request.item.spec.material, findings[0].request);
    assert.equal(request.item.spec.logo, findings[1].request);
    assert.equal(request.item.quantity, findings[2].request);
    assert.equal(request.payment_terms_accepted, findings[5].request);
  });

  test("a sample without the SYNTHETIC marker is refused", () => {
    const request = JSON.parse(readFileSync("samples/synthetic/purchase-request.synthetic.json", "utf8"));
    assert.throws(() => demoInputFromSample({ ...request, _notice: "real data" }));
  });
});

describe("record reference and data source (schema v5)", () => {
  test("short reference PR-XXXXXXXX is derived from the id; same-title records stay distinguishable; id never changes", () => {
    assert.equal(shortProcurementId("pr_79ed0a13-6c23-44c9-a844-40cc6c89ff45"), "PR-79ED0A13");
    const s = store();
    const a = s.create(valid(input({ title: "Same title" })), "USER_INPUT");
    const b = s.create(valid(input({ title: "Same title" })), "USER_INPUT");
    assert.notEqual(a.id, b.id);
    assert.notEqual(shortProcurementId(a.id), shortProcurementId(b.id));
    s.update(a.id, 1, valid(input({ title: "Renamed" })));
    assert.equal(s.get(a.id)!.id, a.id);
    assert.deepEqual(s.list(100, ALL_REQUESTS).map((r) => r.id).sort(), [a.id, b.id].sort());
  });

  test("create records the source: DEMO_SAMPLE when sent, USER_INPUT by default; invalid source → 422", async () => {
    const s = store();
    const demo = await (await handleCreate(req("POST", "/api/procurements", { ...input(), source: "DEMO_SAMPLE" }), s, OPTS)).json();
    assert.equal(demo.record.source, "DEMO_SAMPLE");
    const plain = await (await handleCreate(req("POST", "/api/procurements", input()), s, OPTS)).json();
    assert.equal(plain.record.source, "USER_INPUT");
    for (const bad of ["ADMIN", "demo_sample", 1, null]) {
      const res = await handleCreate(req("POST", "/api/procurements", { ...input(), source: bad }), s, OPTS);
      assert.equal(res.status, 422, `source ${String(bad)}`);
    }
    assert.equal(s.list(100, ALL_REQUESTS).length, 2);
    assert.deepEqual(s.list(100, ALL_REQUESTS).map((r) => r.source).sort(), ["DEMO_SAMPLE", "USER_INPUT"]);
  });

  test("a title containing 'demo' / 'SYNTHETIC' does not make a record demo data", async () => {
    const s = store();
    const res = await handleCreate(req("POST", "/api/procurements", input({ title: "[SYNTHETIC / DEMO] demo bottles — not really" })), s, OPTS);
    assert.equal((await res.json()).record.source, "USER_INPUT");
  });

  test("editing (including the title) never changes the source; PUT cannot set it", async () => {
    const s = store();
    const { record } = await (await handleCreate(req("POST", "/api/procurements", { ...input({ title: "[SYNTHETIC / DEMO] sample" }), source: "DEMO_SAMPLE" }), s, OPTS)).json();
    const renamed = await handleUpdate(req("PUT", `/api/procurements/${record.id}`, { ...putBody(record, { title: "My own title" }), revision: 1 }), record.id, s, OPTS);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).record.source, "DEMO_SAMPLE");
    const sneaky = await handleUpdate(req("PUT", `/api/procurements/${record.id}`, { ...putBody(record), source: "USER_INPUT", revision: 2 }), record.id, s, OPTS);
    assert.equal(sneaky.status, 422);
    assert.equal((await sneaky.json()).errors[0].field, "source");
    assert.equal(s.get(record.id)!.source, "DEMO_SAMPLE");
    assert.equal(s.get(record.id)!.revision, 2);
  });

  test("v4 → v5 migration: backup first, payment and procurement rows kept, source left NULL (not guessed from titles)", () => {
    const path = dbPath();
    const ps = new PaymentStore(path);
    new PaymentService({ store: ps, gateway: null, payeeMerchantId: null }).createTestRecord();
    ps.close();
    const s0 = new ProcurementStore(path);
    const demoTitled = s0.create(valid(input({ title: "[SYNTHETIC / DEMO] PR-DEMO-0001 — bottle" })), "USER_INPUT");
    const plain = s0.create(valid(input({ title: "Ordinary request" })), "USER_INPUT");
    s0.close();
    // Turn it back into a v4 file (no source column), as left by commit 2b97d85.
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE procurement_requests DROP COLUMN source; PRAGMA user_version = 4;");
    const snapshot = (db: DatabaseSync) => ({
      payments: JSON.stringify(db.prepare("SELECT * FROM sandbox_payment_records ORDER BY id").all()),
      events: JSON.stringify(db.prepare("SELECT * FROM sandbox_payment_events ORDER BY seq").all()),
      requests: JSON.stringify(db.prepare("SELECT id, title, revision, created_at, updated_at, budget_max_minor FROM procurement_requests ORDER BY id").all()),
      items: JSON.stringify(db.prepare("SELECT * FROM procurement_request_items ORDER BY request_id, position").all()),
    });
    const before = snapshot(raw);
    raw.close();

    const backups: string[] = [];
    const s = new ProcurementStore(path, { onBackup: (f) => backups.push(f) });
    open.push(s);
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(String.raw`\.v4-before-v${SCHEMA_VERSION}\.`));
    const check = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(snapshot(check), before);
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    check.close();
    const backup = new DatabaseSync(backups[0], { readOnly: true });
    assert.deepEqual(snapshot(backup), before);
    backup.close();
    assert.equal(s.get(demoTitled.id)!.source, null, "demo-looking title is NOT tagged as demo");
    assert.equal(s.get(plain.id)!.source, null);
    // NULL stays allowed for history, anything else is refused by the schema.
    const rw = new DatabaseSync(path);
    assert.throws(() => rw.prepare("UPDATE procurement_requests SET source = 'GUESS' WHERE id = ?").run(plain.id));
    rw.close();
  });
});
