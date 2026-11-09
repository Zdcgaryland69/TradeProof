// Schema v18 (2 Nov 2026): the budget ledger is rebuilt so it can also record Copilot explanations (COPILOT_ANSWER).
// Temporary databases only. M1 existing rows identical in every column (new column NULL), other tables untouched,
// triggers and indexes present, integrity ok, FK 0, backup written; M2 the new constraints; M3 the backup restores the
// pre-migration state; rerun-safety when user_version is behind the tables.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { BUDGET_SCHEMA_V9 } from "../src/server/budget/schema-sql.ts";
import { BudgetStore } from "../src/server/budget/store.ts";
import { openDatabase, SCHEMA_VERSION } from "../src/server/db/database.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { requestInput } from "./helpers/approval-fixtures.ts";
import { testBudget } from "./helpers/budget.ts";

let dir: string;
let n = 0;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-v18-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY_ROWS = [
  ["abl_00000000-0000-4000-8000-000000000001", "qx_a#1", 49135, "SETTLED", 1889, 1117, 14948, "Provider request req_1.", "2026-10-25", "2026-10-25T11:47:44.748Z", "2026-10-25T11:47:50.736Z"],
  ["abl_00000000-0000-4000-8000-000000000002", "qx_b#1", 49049, "UNKNOWN", null, null, null, "Timed out.", "2026-10-25", "2026-10-25T11:48:07.141Z", "2026-10-25T11:48:11.564Z"],
  ["abl_00000000-0000-4000-8000-000000000003", "qx_c#1", 49247, "RELEASED", null, null, null, "Not sent (AUTH).", "2026-10-26", "2026-10-26T01:00:00.000Z", "2026-10-26T01:00:01.000Z"],
] as const;

/** A genuine v17 file: current tables, the ledger in its v9 shape with three rows, user_version 17. */
function v17File(): string {
  const path = join(dir, `v17-${++n}.sqlite`);
  openDatabase(path).close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TRIGGER ai_budget_ledger_close_once; DROP TRIGGER ai_budget_ledger_no_delete; DROP INDEX ai_budget_ledger_copilot; DROP TABLE ai_budget_ledger;");
  db.exec(BUDGET_SCHEMA_V9);
  const price = JSON.stringify({ inputPerMTokMicros: 2000000, outputPerMTokMicros: 10000000, perRequestMicros: 0 });
  for (const r of LEGACY_ROWS) {
    db.prepare(
      `INSERT INTO ai_budget_ledger (id, request_key, purpose, extraction_id, attempt, provider, model, currency, reserved_micros, input_tokens_bound, output_tokens_bound, price_basis, state, input_tokens, output_tokens, settled_micros, outcome_note, budget_day, reserved_at, closed_at)
       VALUES (?, ?, 'QUOTE_EXTRACTION', NULL, 1, 'anthropic', 'claude-sonnet-5-5', 'USD', ?, 2334, 4000, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r[0], r[1], r[2], price, r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]);
  }
  db.exec("PRAGMA user_version = 17");
  db.close();
  return path;
}

const rowsHash = (db: DatabaseSync, sql: string) => createHash("sha256").update(JSON.stringify(db.prepare(sql).all())).digest("hex");
const V9_COLUMNS = "id, request_key, purpose, extraction_id, attempt, provider, model, currency, reserved_micros, input_tokens_bound, output_tokens_bound, price_basis, state, input_tokens, output_tokens, settled_micros, outcome_note, budget_day, reserved_at, closed_at";
const otherTables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'ai_budget_ledger' ORDER BY name").all() as { name: string }[]).map((t) => [t.name, rowsHash(db, `SELECT * FROM "${t.name}" ORDER BY rowid`)]);

describe("schema v18: budget ledger purpose COPILOT_ANSWER", () => {
  test("M1 v17 → v18: rows identical in every column, copilot_request_id NULL, other tables identical, triggers / indexes present, integrity ok, FK 0, backup at v17", () => {
    assert.equal(SCHEMA_VERSION, 18);
    const path = v17File();
    const pre = new DatabaseSync(path, { readOnly: true });
    const ledgerBefore = rowsHash(pre, `SELECT ${V9_COLUMNS} FROM ai_budget_ledger ORDER BY id`);
    const othersBefore = otherTables(pre);
    pre.close();

    openDatabase(path).close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
      assert.equal(rowsHash(db, `SELECT ${V9_COLUMNS} FROM ai_budget_ledger ORDER BY id`), ledgerBefore);
      assert.equal((db.prepare("SELECT count(*) AS c FROM ai_budget_ledger WHERE copilot_request_id IS NOT NULL").get() as { c: number }).c, 0);
      assert.deepEqual(otherTables(db), othersBefore);
      const objects = (db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'ai_budget_ledger' ORDER BY name").all() as { type: string; name: string }[]).map((o) => `${o.type}:${o.name}`);
      for (const o of ["trigger:ai_budget_ledger_close_once", "trigger:ai_budget_ledger_no_delete", "index:ai_budget_ledger_day", "index:ai_budget_ledger_state", "index:ai_budget_ledger_copilot"]) assert.ok(objects.includes(o), `${o} in ${objects}`);
      assert.match(String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ai_budget_ledger_close_once'").get() as { sql: string }).sql), /copilot_request_id IS NOT OLD\.copilot_request_id/);
      assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      db.close();
    }
    const backups = readdirSync(join(dir, "backups")).filter((f) => f.startsWith(`v17-${n}.sqlite.v17-before-v18.`));
    assert.equal(backups.length, 1);

    // M3 restore drill: the backup is the pre-migration file (v17, same ledger rows, v9 shape).
    const b = new DatabaseSync(join(dir, "backups", backups[0]), { readOnly: true });
    try {
      assert.equal((b.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 17);
      assert.equal(rowsHash(b, `SELECT ${V9_COLUMNS} FROM ai_budget_ledger ORDER BY id`), ledgerBefore);
      assert.equal((b.prepare("SELECT count(*) AS c FROM pragma_table_info('ai_budget_ledger') WHERE name = 'copilot_request_id'").get() as { c: number }).c, 0);
      assert.deepEqual(otherTables(b), othersBefore);
    } finally {
      b.close();
    }
  });

  test("M2 constraints: COPILOT_ANSWER needs a request and no run; QUOTE_EXTRACTION never names a request; closed rows immutable; no delete", () => {
    const path = join(dir, `m2-${++n}.sqlite`);
    const ps = new ProcurementStore(path);
    const v = validateProcurementInput(requestInput("A", "m2"), "create");
    assert.ok(v.ok);
    const req = ps.create((v as unknown as { value: never }).value, "USER_INPUT");
    ps.close();
    const ledger = new BudgetStore(path);
    const cfg = testBudget();
    const ok = ledger.reserve(cfg, { requestKey: "copilot:abc#1", purpose: "COPILOT_ANSWER", extractionId: null, copilotRequestId: req.id, attempt: 1, inputTokensBound: 10, outputTokensBound: 10 });
    assert.equal(ok.status, "RESERVED");
    assert.equal((ok as { row: { purpose: string; copilotRequestId: string } }).row.purpose, "COPILOT_ANSWER");
    assert.throws(() => ledger.reserve(cfg, { requestKey: "copilot:nor#1", purpose: "COPILOT_ANSWER", extractionId: null, copilotRequestId: null, attempt: 1, inputTokensBound: 10, outputTokensBound: 10 }), /CHECK constraint failed/);
    assert.throws(() => ledger.reserve(cfg, { requestKey: "qx_x#1", extractionId: null, copilotRequestId: req.id, attempt: 1, inputTokensBound: 10, outputTokensBound: 10 }), /CHECK constraint failed/);
    assert.throws(() => ledger.reserve(cfg, { requestKey: "copilot:fk#1", purpose: "COPILOT_ANSWER", extractionId: null, copilotRequestId: "pr_00000000-0000-4000-8000-00000000dead", attempt: 1, inputTokensBound: 10, outputTokensBound: 10 }), /FOREIGN KEY constraint failed/);
    const id = (ok as { row: { id: string } }).row.id;
    assert.ok(ledger.settle(id, { inputTokens: 5, outputTokens: 5 }));
    ledger.close();
    const db = new DatabaseSync(path);
    try {
      assert.throws(() => db.prepare("UPDATE ai_budget_ledger SET copilot_request_id = NULL WHERE id = ?").run(id), /immutable/);
      assert.throws(() => db.prepare("DELETE FROM ai_budget_ledger WHERE id = ?").run(id), /cannot be deleted/);
    } finally {
      db.close();
    }
  });

  test("rerun-safe: a v18-shaped file whose user_version is behind (17) migrates without rebuilding or changing a row", () => {
    const path = join(dir, `rerun-${++n}.sqlite`);
    openDatabase(path).close();
    const ledger = new BudgetStore(path);
    ledger.reserve(testBudget(), { requestKey: "qx_r#1", extractionId: null, attempt: 1, inputTokensBound: 1, outputTokensBound: 1 });
    ledger.close();
    const raw = new DatabaseSync(path);
    const before = rowsHash(raw, "SELECT * FROM ai_budget_ledger ORDER BY id");
    raw.exec("PRAGMA user_version = 17");
    raw.close();
    openDatabase(path).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(rowsHash(db, "SELECT * FROM ai_budget_ledger ORDER BY id"), before);
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 18);
    } finally {
      db.close();
    }
  });
});
