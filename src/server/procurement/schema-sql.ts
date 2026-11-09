// Schema v4: procurement requests (drafts only in this phase) and their item lines.
// Separate tables from the payment records; no foreign keys between the two.
// The CHECKs repeat the server-side validation limits so a bug in the app layer cannot store
// out-of-range values (lengths are in characters, as SQLite counts them).

export const PROCUREMENT_SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS procurement_requests (
  id                      TEXT PRIMARY KEY CHECK (id GLOB 'pr_*'),
  title                   TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  buyer_company           TEXT CHECK (buyer_company IS NULL OR length(buyer_company) BETWEEN 1 AND 200),
  supplier_name           TEXT CHECK (supplier_name IS NULL OR length(supplier_name) BETWEEN 1 AND 200),
  ship_from               TEXT CHECK (ship_from IS NULL OR length(ship_from) BETWEEN 1 AND 100),
  ship_to                 TEXT CHECK (ship_to IS NULL OR length(ship_to) BETWEEN 1 AND 100),
  budget_currency         TEXT CHECK (budget_currency IS NULL OR budget_currency IN ('USD', 'SGD', 'CNY')),
  budget_max_minor        INTEGER CHECK (budget_max_minor IS NULL OR (typeof(budget_max_minor) = 'integer' AND budget_max_minor >= 0)),
  required_ship_date      TEXT CHECK (required_ship_date IS NULL OR required_ship_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  expected_delivery_date  TEXT CHECK (expected_delivery_date IS NULL OR expected_delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  payment_terms           TEXT CHECK (payment_terms IS NULL OR length(payment_terms) BETWEEN 1 AND 1000),
  additional_requirements TEXT CHECK (additional_requirements IS NULL OR length(additional_requirements) BETWEEN 1 AND 4000),
  status                  TEXT NOT NULL CHECK (status = 'DRAFT'),
  revision                INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (budget_max_minor IS NULL OR budget_currency IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS procurement_requests_updated ON procurement_requests(updated_at DESC, id);
CREATE TABLE IF NOT EXISTS procurement_request_items (
  request_id     TEXT NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 1),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  quantity       INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity > 0)),
  unit           TEXT CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 30),
  material       TEXT CHECK (material IS NULL OR length(material) BETWEEN 1 AND 500),
  specification  TEXT CHECK (specification IS NULL OR length(specification) BETWEEN 1 AND 2000),
  customization  TEXT CHECK (customization IS NULL OR length(customization) BETWEEN 1 AND 1000),
  notes          TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  PRIMARY KEY (request_id, position)
);
`;

// v5: where a request's content came from, for display only (never used for permissions or payment).
// Set once at creation. Rows that existed before v5 keep NULL = "not recorded"; they are not guessed
// from their titles.
export const PROCUREMENT_SCHEMA_V5 = `
ALTER TABLE procurement_requests ADD COLUMN source TEXT CHECK (source IS NULL OR source IN ('USER_INPUT', 'DEMO_SAMPLE'));
`;

// v6: item lines get a stable server-generated id ("pri_<uuid>"). `position` becomes display order only.
// SQLite cannot change a primary key in place, so the table is rebuilt (see database.ts migration 6):
// every existing line receives exactly one new id; rerunning is a no-op once the `id` column exists.
export const PROCUREMENT_ITEMS_V6 = `
CREATE TABLE procurement_request_items_v6 (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'pri_*'),
  request_id     TEXT NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 1),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  quantity       INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity > 0)),
  unit           TEXT CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 30),
  material       TEXT CHECK (material IS NULL OR length(material) BETWEEN 1 AND 500),
  specification  TEXT CHECK (specification IS NULL OR length(specification) BETWEEN 1 AND 2000),
  customization  TEXT CHECK (customization IS NULL OR length(customization) BETWEEN 1 AND 1000),
  notes          TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  UNIQUE (request_id, position)
);
`;

// v7: buyer type (display / wording only; never payment permission) and the buyer's person name.
// Additive, nullable: rows that existed before v7 read NULL = "not recorded" and are never back-filled
// or inferred (not from buyer_company, not from source). Applied column by column, only if missing.
export const PROCUREMENT_V7_COLUMNS: Record<string, string> = {
  buyer_type: `ALTER TABLE procurement_requests ADD COLUMN buyer_type TEXT CHECK (buyer_type IS NULL OR buyer_type IN ('BUSINESS', 'INDIVIDUAL'));`,
  buyer_person_name: `ALTER TABLE procurement_requests ADD COLUMN buyer_person_name TEXT CHECK (buyer_person_name IS NULL OR length(buyer_person_name) BETWEEN 1 AND 200);`,
};

// v8: request revision history. One immutable full snapshot per (request, revision), written in the same
// transaction as the save that created the revision. Triggers: a snapshot can only record the request's
// CURRENT revision and updated_at; a request can only move to revision N+1, and only when revision N is
// recorded (so the chain has no gaps from the baseline on); rows can never be updated or deleted.
// business_time = when that revision was saved; archived_at = when the row was written (they differ only
// for MIGRATION_BASELINE rows, written by the v8 migration for requests that already existed).
export const PROCUREMENT_REVISIONS_V8 = `
CREATE TABLE IF NOT EXISTS procurement_request_revisions (
  request_id        TEXT NOT NULL REFERENCES procurement_requests(id),
  revision          INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  origin            TEXT NOT NULL CHECK (origin IN ('SAVED', 'MIGRATION_BASELINE')),
  snapshot_version  INTEGER NOT NULL CHECK (typeof(snapshot_version) = 'integer' AND snapshot_version >= 1),
  snapshot          TEXT NOT NULL CHECK (json_valid(snapshot)),
  business_time     TEXT NOT NULL,
  archived_at       TEXT NOT NULL,
  PRIMARY KEY (request_id, revision),
  CHECK (json_extract(snapshot, '$.record.id') = request_id),
  CHECK (json_extract(snapshot, '$.record.revision') = revision),
  CHECK (json_extract(snapshot, '$.snapshotVersion') = snapshot_version),
  CHECK (origin <> 'SAVED' OR business_time = archived_at)
);

CREATE TRIGGER IF NOT EXISTS procurement_revisions_current_only
BEFORE INSERT ON procurement_request_revisions
WHEN NEW.revision IS NOT (SELECT revision FROM procurement_requests WHERE id = NEW.request_id)
  OR NEW.business_time IS NOT (SELECT updated_at FROM procurement_requests WHERE id = NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'a revision snapshot must record the current revision of the request'); END;
CREATE TRIGGER IF NOT EXISTS procurement_revisions_immutable BEFORE UPDATE ON procurement_request_revisions
BEGIN SELECT RAISE(ABORT, 'request revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS procurement_revisions_no_delete BEFORE DELETE ON procurement_request_revisions
BEGIN SELECT RAISE(ABORT, 'request revisions cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS procurement_requests_revision_chain
BEFORE UPDATE OF revision ON procurement_requests
WHEN NEW.revision IS NOT OLD.revision
  AND (NEW.revision IS NOT OLD.revision + 1
       OR NOT EXISTS (SELECT 1 FROM procurement_request_revisions WHERE request_id = OLD.id AND revision = OLD.revision))
BEGIN SELECT RAISE(ABORT, 'a request moves only to the next revision, after its current revision is recorded'); END;
`;
