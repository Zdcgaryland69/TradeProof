// Supplier reply tracking.
//
// v11 (28 Oct, first version) linked a draft to a LATER QUOTE VERSION as "the reply". That mixed two things: a
// plain answer to questions became the series' latest quote, made drafts report a newer quote version, and could
// be extracted / compared as revised trade terms. Kept here because the v11 migration must stay replayable.
//
// v12 (28 Oct, fix) separates them:
// - supplier_replies: the supplier's reply text on its own, per quote series (supplier). Entered by the user;
//   the sender is NOT verified. It is never a quote version, never "latest", never extracted or compared.
// - supplier_reply_quote_links: the user's explicit statement "this reply led to updated quote version N".
// - clarification_replies: a draft ↔ supplier reply link (+ the draft revision the user says was sent).
// - clarification_answers: the user's per-question reading of a linked reply; a buyer statement (the user's
//   reviewed wording) replaces the v11 "confirmed term"; each answer records the basis it was made on.
// The v11 rows are carried over unchanged in meaning: the reply text that v11 read from the quote version is
// copied into a supplier_reply marked MIGRATED_FROM_QUOTE_VERSION (that quote version itself stays as it is).

export const REPLY_SCHEMA_V11 = `
CREATE TABLE IF NOT EXISTS clarification_replies (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'cr_*'),
  draft_id          TEXT NOT NULL REFERENCES clarification_drafts(id),
  sent_revision     INTEGER NOT NULL CHECK (typeof(sent_revision) = 'integer' AND sent_revision >= 1),
  reply_version_id  TEXT NOT NULL REFERENCES quote_versions(id),
  note              TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  save_key          TEXT NOT NULL UNIQUE CHECK (length(save_key) = 36),
  created_at        TEXT NOT NULL,
  UNIQUE (draft_id, reply_version_id)
);
CREATE INDEX IF NOT EXISTS clarification_replies_version ON clarification_replies(reply_version_id);

CREATE TRIGGER IF NOT EXISTS clarification_replies_linkage BEFORE INSERT ON clarification_replies
WHEN (SELECT series_id FROM quote_versions WHERE id = NEW.reply_version_id) IS NOT (SELECT series_id FROM clarification_drafts WHERE id = NEW.draft_id)
  OR (SELECT version_number FROM quote_versions WHERE id = NEW.reply_version_id)
     <= (SELECT v.version_number FROM clarification_drafts d JOIN quote_versions v ON v.id = d.version_id WHERE d.id = NEW.draft_id)
  OR NOT EXISTS (SELECT 1 FROM clarification_draft_revisions WHERE draft_id = NEW.draft_id AND revision = NEW.sent_revision)
BEGIN SELECT RAISE(ABORT, 'reply must be a later version of the draft''s quote series and name an existing draft revision'); END;

CREATE TABLE IF NOT EXISTS clarification_answers (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'ca_*'),
  draft_id         TEXT NOT NULL REFERENCES clarification_drafts(id),
  reply_id         TEXT NOT NULL REFERENCES clarification_replies(id),
  question_id      TEXT NOT NULL CHECK (length(question_id) BETWEEN 1 AND 300),
  status           TEXT NOT NULL CHECK (status IN ('ANSWERED', 'PARTLY_ANSWERED', 'NOT_ANSWERED')),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) BETWEEN 1 AND 2000),
  confirmed_term   TEXT CHECK (confirmed_term IS NULL OR length(confirmed_term) BETWEEN 1 AND 500),
  note             TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  supersedes_id    TEXT UNIQUE REFERENCES clarification_answers(id),
  idempotency_key  TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 36),
  fingerprint      TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at       TEXT NOT NULL,
  CHECK ((status = 'NOT_ANSWERED') = (excerpt IS NULL)),
  CHECK (confirmed_term IS NULL OR status = 'ANSWERED')
);
CREATE UNIQUE INDEX IF NOT EXISTS clarification_answers_first ON clarification_answers(draft_id, question_id) WHERE supersedes_id IS NULL;
CREATE INDEX IF NOT EXISTS clarification_answers_draft ON clarification_answers(draft_id, question_id, created_at);

CREATE TRIGGER IF NOT EXISTS clarification_answers_linkage BEFORE INSERT ON clarification_answers
WHEN (SELECT draft_id FROM clarification_replies WHERE id = NEW.reply_id) IS NOT NEW.draft_id
  OR NOT EXISTS (SELECT 1 FROM clarification_drafts d, json_each(d.generated_json, '$.questions') q
                  WHERE d.id = NEW.draft_id AND json_extract(q.value, '$.id') = NEW.question_id)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clarification_answers a
                  WHERE a.id = NEW.supersedes_id AND a.draft_id = NEW.draft_id AND a.question_id = NEW.question_id))
BEGIN SELECT RAISE(ABORT, 'answer does not match its reply, draft question or earlier answer'); END;
CREATE TRIGGER IF NOT EXISTS clarification_answers_excerpt BEFORE INSERT ON clarification_answers
WHEN NEW.excerpt IS NOT NULL
  AND instr((SELECT v.raw_text FROM clarification_replies r JOIN quote_versions v ON v.id = r.reply_version_id WHERE r.id = NEW.reply_id), NEW.excerpt) = 0
BEGIN SELECT RAISE(ABORT, 'answer excerpt must occur in the reply text'); END;

CREATE TRIGGER IF NOT EXISTS clarification_replies_immutable BEFORE UPDATE ON clarification_replies
BEGIN SELECT RAISE(ABORT, 'clarification replies are immutable'); END;
CREATE TRIGGER IF NOT EXISTS clarification_replies_no_delete BEFORE DELETE ON clarification_replies
BEGIN SELECT RAISE(ABORT, 'clarification replies cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS clarification_answers_immutable BEFORE UPDATE ON clarification_answers
BEGIN SELECT RAISE(ABORT, 'clarification answers are append-only'); END;
CREATE TRIGGER IF NOT EXISTS clarification_answers_no_delete BEFORE DELETE ON clarification_answers
BEGIN SELECT RAISE(ABORT, 'clarification answers are append-only'); END;
`;

// A UUID-shaped id from SQLite randomness (for rows created inside the migration).
const sqlUuid = (prefix: string) =>
  `'${prefix}' || lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;

// Runs with foreign-key enforcement off (the migration runner turns it off around the transaction and runs
// PRAGMA foreign_key_check before COMMIT), so the two v11 tables can be rebuilt under their own names.
export const REPLY_SCHEMA_V12 = `
CREATE TABLE supplier_replies (
  id                     TEXT PRIMARY KEY CHECK (id GLOB 'sr_*'),
  request_id             TEXT NOT NULL REFERENCES procurement_requests(id),
  series_id              TEXT NOT NULL REFERENCES quote_series(id),
  raw_text               TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 100000),
  raw_text_sha256        TEXT NOT NULL CHECK (length(raw_text_sha256) = 64),
  source                 TEXT NOT NULL CHECK (source IN ('USER_PASTE', 'TEST_FIXTURE', 'MIGRATED_FROM_QUOTE_VERSION')),
  received_on            TEXT CHECK (received_on IS NULL OR received_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  channel_note           TEXT CHECK (channel_note IS NULL OR length(channel_note) BETWEEN 1 AND 200),
  sender_as_typed        TEXT CHECK (sender_as_typed IS NULL OR length(sender_as_typed) BETWEEN 1 AND 200),
  from_quote_version_id  TEXT REFERENCES quote_versions(id),
  corrects_reply_id      TEXT REFERENCES supplier_replies(id),
  save_key               TEXT NOT NULL UNIQUE CHECK (length(save_key) = 36),
  created_at             TEXT NOT NULL,
  CHECK ((source = 'MIGRATED_FROM_QUOTE_VERSION') = (from_quote_version_id IS NOT NULL))
);
CREATE INDEX supplier_replies_series ON supplier_replies(series_id, created_at);

CREATE TABLE supplier_reply_quote_links (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'srq_*'),
  reply_id          TEXT NOT NULL REFERENCES supplier_replies(id),
  quote_version_id  TEXT NOT NULL REFERENCES quote_versions(id),
  note              TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  save_key          TEXT NOT NULL UNIQUE CHECK (length(save_key) = 36),
  created_at        TEXT NOT NULL,
  UNIQUE (reply_id, quote_version_id)
);

-- v11 rows: the reply text that v11 read from the linked quote version becomes a supplier reply.
CREATE TEMP TABLE v12_reply_map AS
  SELECT r.id AS link_id, ${sqlUuid("sr_")} AS reply_id FROM clarification_replies r;
INSERT INTO supplier_replies (id, request_id, series_id, raw_text, raw_text_sha256, source, received_on, channel_note, sender_as_typed, from_quote_version_id, corrects_reply_id, save_key, created_at)
  SELECT m.reply_id, d.request_id, v.series_id, v.raw_text, v.raw_text_sha256, 'MIGRATED_FROM_QUOTE_VERSION', NULL, NULL, NULL, v.id, NULL,
         lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
         r.created_at
    FROM clarification_replies r JOIN v12_reply_map m ON m.link_id = r.id
    JOIN clarification_drafts d ON d.id = r.draft_id JOIN quote_versions v ON v.id = r.reply_version_id;

DROP TRIGGER clarification_replies_linkage;
DROP TRIGGER clarification_replies_immutable;
DROP TRIGGER clarification_replies_no_delete;
DROP TRIGGER clarification_answers_linkage;
DROP TRIGGER clarification_answers_excerpt;
DROP TRIGGER clarification_answers_immutable;
DROP TRIGGER clarification_answers_no_delete;

CREATE TABLE clarification_replies_v12 (
  id                 TEXT PRIMARY KEY CHECK (id GLOB 'cr_*'),
  draft_id           TEXT NOT NULL REFERENCES clarification_drafts(id),
  supplier_reply_id  TEXT NOT NULL REFERENCES supplier_replies(id),
  sent_revision      INTEGER NOT NULL CHECK (typeof(sent_revision) = 'integer' AND sent_revision >= 1),
  note               TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  save_key           TEXT NOT NULL UNIQUE CHECK (length(save_key) = 36),
  created_at         TEXT NOT NULL,
  UNIQUE (draft_id, supplier_reply_id)
);
INSERT INTO clarification_replies_v12 (id, draft_id, supplier_reply_id, sent_revision, note, save_key, created_at)
  SELECT r.id, r.draft_id, m.reply_id, r.sent_revision, r.note, r.save_key, r.created_at FROM clarification_replies r JOIN v12_reply_map m ON m.link_id = r.id;

CREATE TABLE clarification_answers_v12 (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'ca_*'),
  draft_id          TEXT NOT NULL REFERENCES clarification_drafts(id),
  reply_id          TEXT NOT NULL REFERENCES clarification_replies(id),
  question_id       TEXT NOT NULL CHECK (length(question_id) BETWEEN 1 AND 300),
  status            TEXT NOT NULL CHECK (status IN ('ANSWERED', 'PARTLY_ANSWERED', 'NOT_ANSWERED')),
  excerpt           TEXT CHECK (excerpt IS NULL OR length(excerpt) BETWEEN 1 AND 2000),
  buyer_statement   TEXT CHECK (buyer_statement IS NULL OR length(buyer_statement) BETWEEN 1 AND 500),
  note              TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  basis_json        TEXT CHECK (basis_json IS NULL OR json_valid(basis_json)),
  supersedes_id     TEXT UNIQUE REFERENCES clarification_answers(id),
  idempotency_key   TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 36),
  fingerprint       TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at        TEXT NOT NULL,
  CHECK ((status = 'NOT_ANSWERED') = (excerpt IS NULL)),
  CHECK (buyer_statement IS NULL OR status = 'ANSWERED')
);
-- basis_json stays NULL for v11 rows: their basis was not recorded, so a statement among them never counts as current.
INSERT INTO clarification_answers_v12 (id, draft_id, reply_id, question_id, status, excerpt, buyer_statement, note, basis_json, supersedes_id, idempotency_key, fingerprint, created_at)
  SELECT id, draft_id, reply_id, question_id, status, excerpt, confirmed_term, note, NULL, supersedes_id, idempotency_key, fingerprint, created_at FROM clarification_answers ORDER BY rowid;

DROP TABLE clarification_answers;
DROP TABLE clarification_replies;
DROP TABLE v12_reply_map;
ALTER TABLE clarification_replies_v12 RENAME TO clarification_replies;
ALTER TABLE clarification_answers_v12 RENAME TO clarification_answers;

CREATE INDEX clarification_replies_reply ON clarification_replies(supplier_reply_id);
CREATE UNIQUE INDEX clarification_answers_first ON clarification_answers(draft_id, question_id) WHERE supersedes_id IS NULL;
CREATE INDEX clarification_answers_draft ON clarification_answers(draft_id, question_id, created_at);

CREATE TRIGGER supplier_replies_linkage BEFORE INSERT ON supplier_replies
WHEN (SELECT request_id FROM quote_series WHERE id = NEW.series_id) IS NOT NEW.request_id
  OR (NEW.corrects_reply_id IS NOT NULL AND (SELECT series_id FROM supplier_replies WHERE id = NEW.corrects_reply_id) IS NOT NEW.series_id)
BEGIN SELECT RAISE(ABORT, 'supplier reply does not match its quote series or the reply it corrects'); END;
CREATE TRIGGER supplier_replies_immutable BEFORE UPDATE ON supplier_replies
BEGIN SELECT RAISE(ABORT, 'supplier replies are immutable'); END;
CREATE TRIGGER supplier_replies_no_delete BEFORE DELETE ON supplier_replies
BEGIN SELECT RAISE(ABORT, 'supplier replies cannot be deleted'); END;

CREATE TRIGGER supplier_reply_quote_links_linkage BEFORE INSERT ON supplier_reply_quote_links
WHEN (SELECT series_id FROM quote_versions WHERE id = NEW.quote_version_id) IS NOT (SELECT series_id FROM supplier_replies WHERE id = NEW.reply_id)
BEGIN SELECT RAISE(ABORT, 'updated quote version must belong to the reply''s quote series'); END;
CREATE TRIGGER supplier_reply_quote_links_immutable BEFORE UPDATE ON supplier_reply_quote_links
BEGIN SELECT RAISE(ABORT, 'reply-to-quote links are append-only'); END;
CREATE TRIGGER supplier_reply_quote_links_no_delete BEFORE DELETE ON supplier_reply_quote_links
BEGIN SELECT RAISE(ABORT, 'reply-to-quote links are append-only'); END;

CREATE TRIGGER clarification_replies_linkage BEFORE INSERT ON clarification_replies
WHEN (SELECT series_id FROM supplier_replies WHERE id = NEW.supplier_reply_id) IS NOT (SELECT series_id FROM clarification_drafts WHERE id = NEW.draft_id)
  OR NOT EXISTS (SELECT 1 FROM clarification_draft_revisions WHERE draft_id = NEW.draft_id AND revision = NEW.sent_revision)
BEGIN SELECT RAISE(ABORT, 'reply must belong to the draft''s quote series and name an existing draft revision'); END;
CREATE TRIGGER clarification_replies_immutable BEFORE UPDATE ON clarification_replies
BEGIN SELECT RAISE(ABORT, 'clarification replies are immutable'); END;
CREATE TRIGGER clarification_replies_no_delete BEFORE DELETE ON clarification_replies
BEGIN SELECT RAISE(ABORT, 'clarification replies cannot be deleted'); END;

CREATE TRIGGER clarification_answers_linkage BEFORE INSERT ON clarification_answers
WHEN (SELECT draft_id FROM clarification_replies WHERE id = NEW.reply_id) IS NOT NEW.draft_id
  OR NOT EXISTS (SELECT 1 FROM clarification_drafts d, json_each(d.generated_json, '$.questions') q
                  WHERE d.id = NEW.draft_id AND json_extract(q.value, '$.id') = NEW.question_id)
  OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clarification_answers a
                  WHERE a.id = NEW.supersedes_id AND a.draft_id = NEW.draft_id AND a.question_id = NEW.question_id))
BEGIN SELECT RAISE(ABORT, 'answer does not match its reply, draft question or earlier answer'); END;
CREATE TRIGGER clarification_answers_excerpt BEFORE INSERT ON clarification_answers
WHEN NEW.excerpt IS NOT NULL
  AND instr((SELECT s.raw_text FROM clarification_replies r JOIN supplier_replies s ON s.id = r.supplier_reply_id WHERE r.id = NEW.reply_id), NEW.excerpt) = 0
BEGIN SELECT RAISE(ABORT, 'answer excerpt must occur in the reply text'); END;
CREATE TRIGGER clarification_answers_immutable BEFORE UPDATE ON clarification_answers
BEGIN SELECT RAISE(ABORT, 'clarification answers are append-only'); END;
CREATE TRIGGER clarification_answers_no_delete BEFORE DELETE ON clarification_answers
BEGIN SELECT RAISE(ABORT, 'clarification answers are append-only'); END;
`;

type MigrationDb = { exec(sql: string): void; prepare(sql: string): { all(...args: unknown[]): unknown[] } };

/**
 * v12 step. Rebuilds only a v11-shaped file: a file whose user_version is behind its tables (already v12-shaped,
 * e.g. older-version test fixtures built from a current file) is left as it is, like the v5 column step.
 */
export function migrateRepliesV12(db: MigrationDb): void {
  const columns = db.prepare("PRAGMA table_info(clarification_replies)").all() as { name: string }[];
  if (columns.some((c) => c.name === "supplier_reply_id")) return;
  db.exec(REPLY_SCHEMA_V12);
}

/** v11 step. Skipped for a file whose reply tables are already v12-shaped (its index would name a v11 column). */
export function migrateRepliesV11(db: MigrationDb): void {
  const columns = db.prepare("PRAGMA table_info(clarification_replies)").all() as { name: string }[];
  if (columns.some((c) => c.name === "supplier_reply_id")) return;
  db.exec(REPLY_SCHEMA_V11);
}

// v13 (29 Oct): the buyer classifies each statement — confirms the condition the saved quote already states,
// proposes a new condition, or unclear. One added column (existing rows keep NULL = "not classified", shown as
// needing manual review) and an insert-time rule that a new statement and its classification come together.
// No row is changed.
export const REPLY_SCHEMA_V13 = `
ALTER TABLE clarification_answers ADD COLUMN statement_kind TEXT
  CHECK (statement_kind IS NULL OR statement_kind IN ('CONFIRMS_ORIGINAL', 'PROPOSES_NEW', 'UNCLEAR'));
CREATE TRIGGER clarification_answers_statement_kind BEFORE INSERT ON clarification_answers
WHEN (NEW.buyer_statement IS NULL) <> (NEW.statement_kind IS NULL)
BEGIN SELECT RAISE(ABORT, 'a buyer statement and its classification are recorded together'); END;
`;

/** v13 step. Skipped for a file whose answers table already has the column (user_version behind its tables). */
export function migrateRepliesV13(db: MigrationDb): void {
  const columns = db.prepare("PRAGMA table_info(clarification_answers)").all() as { name: string }[];
  if (columns.some((c) => c.name === "statement_kind")) return;
  db.exec(REPLY_SCHEMA_V13);
}
