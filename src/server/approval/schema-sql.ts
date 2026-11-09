// Approval condition snapshots (29 Oct, schema v14). Design: docs/approval-design.md.
//
// - approvals: one IMMUTABLE row per in-app human approval of the latest complete conditions of a quote series.
//   It stores the canonical snapshot the user saw (digest-bound), the confirmations given, the facts later
//   validity checks compare against, and the actor. It is never updated or deleted; current validity is derived.
// - approval_events: append-only INVALIDATED / REVOKED rows. The first one is terminal (never undone).
// - approval_payments: append-only link approval → Sandbox payment record (amount copied from the snapshot).
// - requirement_classifications: append-only buyer classification of free-text requirements (item notes,
//   additional requirements) for one quote version: not key (with reason), key and stated in the quote (with a
//   verbatim excerpt the server found in the quote text), or key and not stated. The latest row per subject wins.
// No existing table or row is touched and nothing is back-filled.

export const APPROVAL_SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS approvals (
  id                       TEXT PRIMARY KEY CHECK (id GLOB 'ap_*'),
  request_id               TEXT NOT NULL REFERENCES procurement_requests(id),
  series_id                TEXT NOT NULL REFERENCES quote_series(id),
  version_id               TEXT NOT NULL REFERENCES quote_versions(id),
  base_version_id          TEXT REFERENCES quote_versions(id),
  run_id                   TEXT NOT NULL REFERENCES quote_extraction_runs(id),
  base_run_id              TEXT REFERENCES quote_extraction_runs(id),
  request_revision         INTEGER NOT NULL CHECK (typeof(request_revision) = 'integer' AND request_revision >= 1),
  request_fingerprint      TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  latest_version_number    INTEGER NOT NULL CHECK (typeof(latest_version_number) = 'integer' AND latest_version_number >= 1),
  reviews_digest           TEXT NOT NULL CHECK (length(reviews_digest) = 64),
  statements_digest        TEXT NOT NULL CHECK (length(statements_digest) = 64),
  classifications_digest   TEXT NOT NULL CHECK (length(classifications_digest) = 64),
  payee_fingerprint        TEXT NOT NULL CHECK (length(payee_fingerprint) = 64),
  rules                    TEXT NOT NULL,
  amount_minor             INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  currency                 TEXT NOT NULL CHECK (length(currency) = 3),
  snapshot_json            TEXT NOT NULL,
  preview_digest           TEXT NOT NULL CHECK (length(preview_digest) = 64),
  confirmed_json           TEXT NOT NULL,
  actor_kind               TEXT NOT NULL CHECK (actor_kind IN ('LOCAL_DEV', 'BUYER', 'APPROVER')),
  actor_id                 TEXT,
  actor_authenticated      INTEGER NOT NULL CHECK (actor_authenticated IN (0, 1)),
  idempotency_key          TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 36),
  fingerprint              TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at               TEXT NOT NULL,
  CHECK (actor_kind <> 'LOCAL_DEV' OR (actor_id IS NULL AND actor_authenticated = 0)),
  CHECK ((base_version_id IS NULL) = (base_run_id IS NULL))
);
CREATE INDEX IF NOT EXISTS approvals_request ON approvals(request_id, created_at);
CREATE TRIGGER IF NOT EXISTS approvals_immutable BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS approval_events (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'ape_*'),
  approval_id  TEXT NOT NULL REFERENCES approvals(id),
  kind         TEXT NOT NULL CHECK (kind IN ('INVALIDATED', 'REVOKED')),
  reasons_json TEXT NOT NULL,
  note         TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  actor_kind   TEXT CHECK (actor_kind IS NULL OR actor_kind IN ('LOCAL_DEV', 'BUYER', 'APPROVER')),
  idempotency_key TEXT UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) = 36),
  created_at   TEXT NOT NULL,
  CHECK (kind <> 'REVOKED' OR (note IS NOT NULL AND actor_kind IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS approval_events_approval ON approval_events(approval_id, created_at);
CREATE TRIGGER IF NOT EXISTS approval_events_immutable BEFORE UPDATE ON approval_events
BEGIN SELECT RAISE(ABORT, 'approval events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS approval_events_no_delete BEFORE DELETE ON approval_events
BEGIN SELECT RAISE(ABORT, 'approval events cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS approval_payments (
  approval_id        TEXT NOT NULL REFERENCES approvals(id),
  payment_record_id  TEXT NOT NULL UNIQUE REFERENCES sandbox_payment_records(id),
  created_at         TEXT NOT NULL,
  PRIMARY KEY (approval_id, payment_record_id)
);
CREATE TRIGGER IF NOT EXISTS approval_payments_immutable BEFORE UPDATE ON approval_payments
BEGIN SELECT RAISE(ABORT, 'approval payment links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS approval_payments_no_delete BEFORE DELETE ON approval_payments
BEGIN SELECT RAISE(ABORT, 'approval payment links cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS requirement_classifications (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'rc_*'),
  request_id       TEXT NOT NULL REFERENCES procurement_requests(id),
  version_id       TEXT NOT NULL REFERENCES quote_versions(id),
  subject          TEXT NOT NULL CHECK (subject = 'ADDITIONAL_REQUIREMENTS' OR subject GLOB 'ITEM_NOTES:pri_*'),
  text_sha256      TEXT NOT NULL CHECK (length(text_sha256) = 64),
  decision         TEXT NOT NULL CHECK (decision IN ('NOT_KEY', 'KEY_IN_QUOTE', 'KEY_NOT_IN_QUOTE')),
  reason           TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) BETWEEN 1 AND 2000),
  excerpt_version_id TEXT REFERENCES quote_versions(id),
  idempotency_key  TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 36),
  fingerprint      TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at       TEXT NOT NULL,
  CHECK ((decision = 'KEY_IN_QUOTE') = (excerpt IS NOT NULL AND excerpt_version_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS requirement_classifications_version ON requirement_classifications(version_id, subject, created_at);
CREATE TRIGGER IF NOT EXISTS requirement_classifications_immutable BEFORE UPDATE ON requirement_classifications
BEGIN SELECT RAISE(ABORT, 'requirement classifications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS requirement_classifications_no_delete BEFORE DELETE ON requirement_classifications
BEGIN SELECT RAISE(ABORT, 'requirement classifications cannot be deleted'); END;
`;

// v17 (31 Oct, R-ACCESS-CLOCK): an approval by an assigned approver records WHICH grant it was made under — the
// approver_grants sequence number of the GRANT row that was current inside the approve transaction. Removal after the
// approval is then decided by sequence (any REVOKE with a higher seq), never by wall-clock times. Existing rows keep
// NULL: their grant is not known, so an approver's approval without it cannot start or continue a payment (a new
// approval is needed). New APPROVER rows must name a GRANT row of the same request and approver.
export const APPROVAL_V17_COLUMN = `ALTER TABLE approvals ADD COLUMN approver_grant_seq INTEGER REFERENCES approver_grants(seq);`;
export const APPROVAL_V17_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS approvals_grant_basis BEFORE INSERT ON approvals WHEN NEW.actor_kind = 'APPROVER'
  AND NOT EXISTS (SELECT 1 FROM approver_grants g WHERE g.seq = NEW.approver_grant_seq AND g.request_id = NEW.request_id AND g.approver_id = NEW.actor_id AND g.action = 'GRANT')
BEGIN SELECT RAISE(ABORT, 'an approver approval must name the GRANT it was made under'); END;
`;
