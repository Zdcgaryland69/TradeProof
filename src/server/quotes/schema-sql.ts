// Schema v6: supplier quotes. One procurement request → many quote series → many immutable versions.
// Versions are append-only: triggers refuse UPDATE and DELETE, so saved text, metadata and the linked
// request snapshot cannot be overwritten even by a bug in the app layer.

export const QUOTE_SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS quote_series (
  id                     TEXT PRIMARY KEY CHECK (id GLOB 'qs_*'),
  request_id             TEXT NOT NULL REFERENCES procurement_requests(id),
  name                   TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  supplier_display_name  TEXT CHECK (supplier_display_name IS NULL OR length(supplier_display_name) BETWEEN 1 AND 200),
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quote_series_request ON quote_series(request_id, created_at);

CREATE TABLE IF NOT EXISTS quote_versions (
  id                      TEXT PRIMARY KEY CHECK (id GLOB 'qv_*'),
  series_id               TEXT NOT NULL REFERENCES quote_series(id),
  version_number          INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  content_kind            TEXT NOT NULL CHECK (content_kind IN ('FULL_QUOTE', 'SUPPLEMENT')),
  supplements_version_id  TEXT REFERENCES quote_versions(id),
  raw_text                TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 100000),
  raw_text_sha256         TEXT NOT NULL CHECK (length(raw_text_sha256) = 64),
  source                  TEXT NOT NULL CHECK (source IN ('USER_PASTE', 'DEMO_SAMPLE', 'TEST_FIXTURE')),
  source_note             TEXT CHECK (source_note IS NULL OR length(source_note) BETWEEN 1 AND 500),
  supplier_quote_date     TEXT CHECK (supplier_quote_date IS NULL OR supplier_quote_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  revision_note           TEXT CHECK (revision_note IS NULL OR length(revision_note) BETWEEN 1 AND 1000),
  request_revision        INTEGER NOT NULL CHECK (typeof(request_revision) = 'integer' AND request_revision >= 1),
  request_snapshot        TEXT NOT NULL CHECK (json_valid(request_snapshot)),
  saved_at                TEXT NOT NULL,
  UNIQUE (series_id, version_number),
  CHECK ((content_kind = 'SUPPLEMENT') = (supplements_version_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS quote_save_keys (
  key          TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL CHECK (length(fingerprint) = 64),
  version_id   TEXT NOT NULL REFERENCES quote_versions(id),
  created_at   TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS quote_versions_supplement_same_series
BEFORE INSERT ON quote_versions
WHEN NEW.supplements_version_id IS NOT NULL
  AND (SELECT series_id FROM quote_versions WHERE id = NEW.supplements_version_id) IS NOT NEW.series_id
BEGIN SELECT RAISE(ABORT, 'supplement must refer to a version of the same quote series'); END;

CREATE TRIGGER IF NOT EXISTS quote_versions_immutable BEFORE UPDATE ON quote_versions
BEGIN SELECT RAISE(ABORT, 'quote versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quote_versions_no_delete BEFORE DELETE ON quote_versions
BEGIN SELECT RAISE(ABORT, 'quote versions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS quote_series_immutable BEFORE UPDATE ON quote_series
BEGIN SELECT RAISE(ABORT, 'quote series are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quote_series_no_delete BEFORE DELETE ON quote_series
BEGIN SELECT RAISE(ABORT, 'quote series cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS quote_save_keys_immutable BEFORE UPDATE ON quote_save_keys
BEGIN SELECT RAISE(ABORT, 'idempotency keys are immutable'); END;
`;

// v7: AI extraction of a saved quote version, the user's review of it, and supplier quote numbers.
// All derived from a version; none of it changes the version, its text, hash or request snapshot.
//
// quote_extraction_runs: one row per extraction request. Created RUNNING, then finished exactly once
// (SUCCEEDED / INCOMPLETE / FAILED); after that the row is immutable. Never deleted. Insert-time triggers
// check that request → series → version belong together and that input_sha256 is the version's hash.
// mode MOCK = canned test output, never shown as an AI result.
// quote_extraction_reviews: the user's confirm / reject / correct / item-match decisions, append-only;
// the model's own output (raw_output, result_json) is never edited.
// quote_version_supplier_refs: supplier quote number per version, append-only (design §2.3). An
// AI_CANDIDATE row must carry an excerpt that occurs verbatim in that version's text (trigger).
export const QUOTE_SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS quote_extraction_runs (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'qx_*'),
  request_id          TEXT NOT NULL REFERENCES procurement_requests(id),
  series_id           TEXT NOT NULL REFERENCES quote_series(id),
  version_id          TEXT NOT NULL REFERENCES quote_versions(id),
  input_sha256        TEXT NOT NULL CHECK (length(input_sha256) = 64),
  request_revision    INTEGER NOT NULL CHECK (typeof(request_revision) = 'integer' AND request_revision >= 1),
  context_version_id  TEXT REFERENCES quote_versions(id),
  mode                TEXT NOT NULL CHECK (mode IN ('LIVE', 'MOCK')),
  provider            TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 50),
  model               TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  prompt_version      TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 50),
  schema_version      TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 50),
  idempotency_key     TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'INCOMPLETE', 'FAILED')),
  error_code          TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 50),
  error_message       TEXT CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  input_tokens        INTEGER CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens       INTEGER CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  raw_output          TEXT CHECK (raw_output IS NULL OR length(raw_output) <= 200000),
  result_json         TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CHECK (status NOT IN ('SUCCEEDED', 'INCOMPLETE') OR result_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS quote_extraction_runs_version ON quote_extraction_runs(version_id, started_at);

CREATE TRIGGER IF NOT EXISTS quote_extraction_runs_linkage
BEFORE INSERT ON quote_extraction_runs
WHEN (SELECT series_id FROM quote_versions WHERE id = NEW.version_id) IS NOT NEW.series_id
  OR (SELECT request_id FROM quote_series WHERE id = NEW.series_id) IS NOT NEW.request_id
  OR (SELECT raw_text_sha256 FROM quote_versions WHERE id = NEW.version_id) IS NOT NEW.input_sha256
  OR (NEW.context_version_id IS NOT NULL AND (SELECT series_id FROM quote_versions WHERE id = NEW.context_version_id) IS NOT NEW.series_id)
BEGIN SELECT RAISE(ABORT, 'extraction run does not match its quote version'); END;

CREATE TRIGGER IF NOT EXISTS quote_extraction_runs_finish_once
BEFORE UPDATE ON quote_extraction_runs
WHEN OLD.status <> 'RUNNING'
  OR NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.series_id IS NOT OLD.series_id
  OR NEW.version_id IS NOT OLD.version_id OR NEW.input_sha256 IS NOT OLD.input_sha256
  OR NEW.request_revision IS NOT OLD.request_revision OR NEW.context_version_id IS NOT OLD.context_version_id
  OR NEW.mode IS NOT OLD.mode OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model
  OR NEW.prompt_version IS NOT OLD.prompt_version OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'finished extraction runs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quote_extraction_runs_no_delete BEFORE DELETE ON quote_extraction_runs
BEGIN SELECT RAISE(ABORT, 'extraction runs cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS quote_extraction_reviews (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'qxr_*'),
  extraction_id    TEXT NOT NULL REFERENCES quote_extraction_runs(id),
  field_path       TEXT NOT NULL CHECK (length(field_path) BETWEEN 1 AND 200),
  action           TEXT NOT NULL CHECK (action IN ('CONFIRM', 'REJECT', 'CORRECT', 'MATCH_ITEM', 'NO_MATCH')),
  value_text       TEXT CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 1000),
  request_item_id  TEXT CHECK (request_item_id IS NULL OR request_item_id GLOB 'pri_*'),
  supersedes_id    TEXT REFERENCES quote_extraction_reviews(id),
  idempotency_key  TEXT NOT NULL UNIQUE,
  fingerprint      TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at       TEXT NOT NULL,
  CHECK ((action = 'CORRECT') = (value_text IS NOT NULL)),
  CHECK ((action = 'MATCH_ITEM') = (request_item_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS quote_extraction_reviews_run ON quote_extraction_reviews(extraction_id, field_path, created_at);
CREATE TRIGGER IF NOT EXISTS quote_extraction_reviews_immutable BEFORE UPDATE ON quote_extraction_reviews
BEGIN SELECT RAISE(ABORT, 'extraction reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS quote_extraction_reviews_no_delete BEFORE DELETE ON quote_extraction_reviews
BEGIN SELECT RAISE(ABORT, 'extraction reviews are append-only'); END;

CREATE TABLE IF NOT EXISTS quote_version_supplier_refs (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'qvr_*'),
  version_id      TEXT NOT NULL REFERENCES quote_versions(id),
  value_raw       TEXT CHECK (value_raw IS NULL OR length(value_raw) BETWEEN 1 AND 100),
  origin          TEXT NOT NULL CHECK (origin IN ('USER_ENTERED', 'AI_CANDIDATE', 'USER_CONFIRMED', 'USER_CLEARED')),
  evidence_text   TEXT CHECK (evidence_text IS NULL OR length(evidence_text) BETWEEN 1 AND 2000),
  extraction_id   TEXT REFERENCES quote_extraction_runs(id),
  supersedes_id   TEXT REFERENCES quote_version_supplier_refs(id),
  created_at      TEXT NOT NULL,
  CHECK (origin <> 'AI_CANDIDATE' OR (value_raw IS NOT NULL AND evidence_text IS NOT NULL AND extraction_id IS NOT NULL)),
  CHECK ((origin = 'USER_CLEARED') = (value_raw IS NULL))
);
CREATE INDEX IF NOT EXISTS quote_version_supplier_refs_version ON quote_version_supplier_refs(version_id, created_at);
CREATE TRIGGER IF NOT EXISTS quote_version_supplier_refs_evidence
BEFORE INSERT ON quote_version_supplier_refs
WHEN NEW.evidence_text IS NOT NULL
  AND instr((SELECT raw_text FROM quote_versions WHERE id = NEW.version_id), NEW.evidence_text) = 0
BEGIN SELECT RAISE(ABORT, 'supplier quote number evidence must occur in the version text'); END;
CREATE TRIGGER IF NOT EXISTS quote_version_supplier_refs_immutable BEFORE UPDATE ON quote_version_supplier_refs
BEGIN SELECT RAISE(ABORT, 'supplier quote numbers are append-only'); END;
CREATE TRIGGER IF NOT EXISTS quote_version_supplier_refs_no_delete BEFORE DELETE ON quote_version_supplier_refs
BEGIN SELECT RAISE(ABORT, 'supplier quote numbers are append-only'); END;
`;
