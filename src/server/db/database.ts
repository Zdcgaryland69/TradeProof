// Shared local SQLite database (node:sqlite) for the payment and procurement modules.
// One file, one schema version (PRAGMA user_version), separate tables per module.
// Nothing here runs at import time: the file is only opened when a store is constructed.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RECORD_STATUSES } from "../payments/types.ts";
import { recordRevision } from "../procurement/records.ts";
import { PROCUREMENT_ITEMS_V6, PROCUREMENT_REVISIONS_V8, PROCUREMENT_SCHEMA_V4, PROCUREMENT_SCHEMA_V5, PROCUREMENT_V7_COLUMNS } from "../procurement/schema-sql.ts";
import { BUDGET_LEDGER_V18_OBJECTS, BUDGET_LEDGER_V18_TABLE, BUDGET_SCHEMA_V9 } from "../budget/schema-sql.ts";
import { CLARIFICATION_SCHEMA_V10 } from "../clarification/schema-sql.ts";
import { QUOTE_SCHEMA_V6, QUOTE_SCHEMA_V7 } from "../quotes/schema-sql.ts";
import { migrateRepliesV11, migrateRepliesV12, migrateRepliesV13 } from "../replies/schema-sql.ts";
import { APPROVAL_SCHEMA_V14, APPROVAL_V17_COLUMN, APPROVAL_V17_TRIGGER } from "../approval/schema-sql.ts";
import { ACCESS_SCHEMA_V15, ACCESS_SCHEMA_V16 } from "../auth/schema-sql.ts";

export const SCHEMA_VERSION = 18;

const statusList = RECORD_STATUSES.map((s) => `'${s}'`).join(", ");

// v1 base schema (payments). Later versions are applied as MIGRATIONS so existing local DBs keep their records.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sandbox_payment_records (
  id                    TEXT PRIMARY KEY,
  sku                   TEXT NOT NULL,
  item_name             TEXT NOT NULL,
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  status                TEXT NOT NULL CHECK (status IN (${statusList})),
  create_request_id     TEXT NOT NULL UNIQUE,
  capture_request_id    TEXT UNIQUE,
  paypal_order_id       TEXT UNIQUE,
  paypal_capture_id     TEXT UNIQUE,
  paypal_order_status   TEXT,
  paypal_capture_status TEXT,
  lease_until           INTEGER,
  last_error            TEXT,
  review_reasons        TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  paid_at               TEXT,
  CHECK (capture_request_id IS NULL OR capture_request_id <> create_request_id),
  CHECK (status <> 'PAID' OR (paypal_order_id IS NOT NULL AND paypal_capture_id IS NOT NULL AND paid_at IS NOT NULL)),
  CHECK (status IN ('NEW', 'ORDER_CREATING', 'FAILED') OR paypal_order_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS sandbox_payment_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL REFERENCES sandbox_payment_records(id),
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS sandbox_payment_events_record ON sandbox_payment_events(record_id, seq);
`;

/** SQL text, or a function for steps that must check the current schema first (idempotent). */
const MIGRATIONS: Record<number, string | ((db: DatabaseSync) => void)> = {
  // v2: when each PayPal-Request-Id was first used (epoch ms), to respect PayPal's idempotency
  // retention window before any automatic retry with the same id.
  2: `ALTER TABLE sandbox_payment_records ADD COLUMN create_started_at INTEGER;
      ALTER TABLE sandbox_payment_records ADD COLUMN capture_started_at INTEGER;`,
  // v3: PayPal's own clock at the first capture attempt, so the retry window does not depend only on
  // the local wall clock (which can lose time or be set back).
  3: `ALTER TABLE sandbox_payment_records ADD COLUMN capture_started_paypal_at INTEGER;`,
  // v4: procurement requests (drafts) and their items. Payment tables are not touched.
  4: PROCUREMENT_SCHEMA_V4,
  // v5: procurement_requests.source (USER_INPUT | DEMO_SAMPLE | NULL = not recorded).
  // Adds the column only if missing, so a file whose user_version is behind its tables still migrates.
  5: (db) => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('procurement_requests')").all() as Row[];
    if (!columns.some((c) => c.name === "source")) db.exec(PROCUREMENT_SCHEMA_V5);
  },
  // v6: stable item ids + quote series / immutable versions / idempotency keys.
  // Items: rebuilt once with one new id per existing line (same order, same values). Skipped when the
  // table already has `id`, so a rerun never generates new ids. Payment tables are not touched.
  6: (db) => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('procurement_request_items')").all() as Row[];
    if (!columns.some((c) => c.name === "id")) {
      db.exec(PROCUREMENT_ITEMS_V6);
      const rows = db.prepare("SELECT * FROM procurement_request_items ORDER BY request_id, position").all() as Row[];
      const insert = db.prepare(
        `INSERT INTO procurement_request_items_v6
           (id, request_id, position, name, quantity, unit, material, specification, customization, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(`pri_${randomUUID()}`, r.request_id as string, r.position as number, r.name as string, r.quantity as number | null,
          r.unit as string | null, r.material as string | null, r.specification as string | null, r.customization as string | null, r.notes as string | null);
      }
      db.exec(`DROP TABLE procurement_request_items;
               ALTER TABLE procurement_request_items_v6 RENAME TO procurement_request_items;`);
    }
    db.exec(QUOTE_SCHEMA_V6);
  },
  // v7: buyer type + person name (nullable columns: existing rows stay "not recorded"), AI extraction
  // runs / reviews and supplier quote numbers (new tables). Additive only: no table is rebuilt, no
  // existing row is updated, no trigger is dropped. Each part is skipped when already present.
  7: (db) => {
    const columns = new Set((db.prepare("SELECT name FROM pragma_table_info('procurement_requests')").all() as Row[]).map((c) => c.name));
    for (const [column, sql] of Object.entries(PROCUREMENT_V7_COLUMNS)) if (!columns.has(column)) db.exec(sql);
    db.exec(QUOTE_SCHEMA_V7);
  },
  // v8: request revision history. Every existing request gets ONE row: its current state as a
  // MIGRATION_BASELINE of its current revision (business time = its own updated_at, archive time = now).
  // Earlier revisions were never stored and are not reconstructed. No existing row is changed. A request
  // that already has a row for its current revision is skipped, so a rerun adds nothing.
  8: (db) => {
    db.exec(PROCUREMENT_REVISIONS_V8);
    const archivedAt = new Date().toISOString();
    const missing = db
      .prepare(
        `SELECT r.id FROM procurement_requests r
          WHERE NOT EXISTS (SELECT 1 FROM procurement_request_revisions h WHERE h.request_id = r.id AND h.revision = r.revision)
          ORDER BY r.created_at, r.id`,
      )
      .all() as Row[];
    for (const r of missing) recordRevision(db, String(r.id), "MIGRATION_BASELINE", archivedAt);
  },
  // v9: overall API budget ledger for LIVE model calls (new table + triggers only). No existing table or
  // row is touched. Nothing is back-filled: no LIVE call has ever been made, so there is no spend to record.
  9: BUDGET_SCHEMA_V9,
  // v10: bilingual clarification drafts (two new append-only tables + triggers). No existing table or row is
  // touched and nothing is back-filled.
  10: CLARIFICATION_SCHEMA_V10,
  // v11: supplier reply tracking (two new append-only tables + triggers). No existing table or row is touched
  // and nothing is back-filled.
  11: migrateRepliesV11,
  // v12: supplier replies stored on their own (no longer as quote versions); the two v11 tables are rebuilt
  // under their names with every v11 row carried over (reply text copied from the quote version it was read
  // from, marked MIGRATED_FROM_QUOTE_VERSION; answer basis not recorded → never treated as current).
  12: migrateRepliesV12,
  // v13: the buyer's classification of a statement (one added column + an insert-time rule). No row is changed;
  // earlier statements stay unclassified (shown as needing manual review).
  13: migrateRepliesV13,
  // v14: approval condition snapshots (four new immutable / append-only tables + triggers). No existing table or
  // row is touched and nothing is back-filled.
  14: APPROVAL_SCHEMA_V14,
  // v15: sign-in and object-level access (accounts, sessions, ownership, approver grants, audit). Five new tables +
  // triggers; no existing table or row is touched; existing requests get no owner.
  15: ACCESS_SCHEMA_V15,
  // v16: local password reset — principals allow a password-hash change only; sessions rebuilt (rows copied) to allow
  // the revocation reason PASSWORD_RESET.
  16: ACCESS_SCHEMA_V16,
  // v17: approvals record the approver's grant sequence (removal ordered by the database, not the clock); old rows NULL.
  // Adds the column only if missing (a file whose user_version is behind its tables still migrates); no row is changed.
  17: (db) => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('approvals')").all() as Row[];
    if (!columns.some((c) => c.name === "approver_grant_seq")) db.exec(APPROVAL_V17_COLUMN);
    db.exec(APPROVAL_V17_TRIGGER);
  },
  // v18 (2 Nov): the budget ledger also records Copilot explanations (purpose COPILOT_ANSWER, copilot_request_id).
  // The table is rebuilt (a CHECK cannot be altered) with every row copied unchanged and copilot_request_id NULL; the
  // rebuild is skipped when the column already exists (a file whose user_version is behind its tables).
  18: (db) => {
    const columns = db.prepare("SELECT name FROM pragma_table_info('ai_budget_ledger')").all() as Row[];
    if (!columns.some((c) => c.name === "copilot_request_id")) db.exec(BUDGET_LEDGER_V18_TABLE);
    db.exec(BUDGET_LEDGER_V18_OBJECTS);
  },
};

type Row = Record<string, unknown>;

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
}

function backupName(filePath: string, from: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dirname(filePath), "backups", `${basename(filePath)}.v${from}-before-v${SCHEMA_VERSION}.${stamp}.sqlite`);
}

export interface OpenOptions {
  /** Called with the backup file path when an existing database was copied before migrating. */
  onBackup?: (path: string) => void;
  /** How long a statement waits for another connection's lock before failing with SQLITE_BUSY (default 5000 ms). */
  busyTimeoutMs?: number;
}

/**
 * Open (creating if needed) the local database and bring it to SCHEMA_VERSION.
 * Before migrating a database that already holds data, a consistent copy is written with
 * `VACUUM INTO` to `<dir>/backups/`; if the copy fails, nothing is migrated.
 */
export function openDatabase(filePath: string, options: OpenOptions = {}): DatabaseSync {
  const isFile = filePath !== ":memory:";
  const existed = isFile && existsSync(filePath);
  if (isFile) mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    // busy_timeout first: `journal_mode = WAL` already takes a lock (WAL recovery / wal-index), and without a
    // busy handler a connection opened while another one holds it fails at once with "database is locked"
    // (SQLITE_BUSY / SQLITE_BUSY_RECOVERY) instead of waiting. Seen with 12 threads opening one file together.
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate(db, filePath, existed, options);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function migrate(db: DatabaseSync, filePath: string, existed: boolean, options: OpenOptions): void {
  const before = userVersion(db);
  if (before > SCHEMA_VERSION) throw new Error(`Local DB schema v${before} is newer than this code (v${SCHEMA_VERSION})`);
  if (before === SCHEMA_VERSION) return;

  if (existed && before >= 1) {
    const target = backupName(filePath, before);
    mkdirSync(dirname(target), { recursive: true });
    db.prepare("VACUUM INTO ?").run(target);
    options.onBackup?.(target);
  }

  // Table rebuilds (v12) follow SQLite's documented procedure: foreign keys off around the transaction (the
  // pragma is a no-op inside one), PRAGMA foreign_key_check before COMMIT, and back on afterwards.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read inside the write lock: another connection may have migrated meanwhile.
    const version = userVersion(db);
    if (version < 1) db.exec(SCHEMA_V1);
    for (let v = Math.max(version, 1) + 1; v <= SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v];
      if (typeof step === "string") db.exec(step);
      else step(db);
    }
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length > 0) throw new Error(`migration left ${broken.length} foreign-key violation(s); nothing was changed`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
