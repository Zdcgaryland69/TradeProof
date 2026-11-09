// Schema v10 (27 Oct): bilingual clarification drafts. Two new tables + triggers; no existing table or row
// is touched. A draft row holds what it was generated from (source snapshot, template version, the
// generated questions) and never changes. Its texts live in append-only revisions: revision 1 is the
// generated text (GENERATED), later ones are the user's saves (USER_EDIT). Nothing here is sent anywhere,
// approved or confirmed; copying a draft writes nothing.

export const CLARIFICATION_SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS clarification_drafts (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'cd_*'),
  request_id          TEXT NOT NULL REFERENCES procurement_requests(id),
  series_id           TEXT NOT NULL REFERENCES quote_series(id),
  version_id          TEXT NOT NULL REFERENCES quote_versions(id),
  extraction_id       TEXT NOT NULL REFERENCES quote_extraction_runs(id),
  base_extraction_id  TEXT REFERENCES quote_extraction_runs(id),
  template_version    TEXT NOT NULL CHECK (length(template_version) BETWEEN 1 AND 100),
  comparator_version  TEXT NOT NULL CHECK (length(comparator_version) BETWEEN 1 AND 100),
  source_fingerprint  TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  source_json         TEXT NOT NULL CHECK (json_valid(source_json)),
  generated_json      TEXT NOT NULL CHECK (json_valid(generated_json)),
  supersedes_id       TEXT REFERENCES clarification_drafts(id),
  created_at          TEXT NOT NULL
);
-- One draft per basis: the same run, base run and source state never produce a second draft.
CREATE UNIQUE INDEX IF NOT EXISTS clarification_drafts_basis
  ON clarification_drafts(version_id, extraction_id, coalesce(base_extraction_id, ''), source_fingerprint);
CREATE INDEX IF NOT EXISTS clarification_drafts_request ON clarification_drafts(request_id, created_at);

CREATE TABLE IF NOT EXISTS clarification_draft_revisions (
  draft_id        TEXT NOT NULL REFERENCES clarification_drafts(id),
  revision        INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  origin          TEXT NOT NULL CHECK (origin IN ('GENERATED', 'USER_EDIT')),
  content_json    TEXT NOT NULL CHECK (json_valid(content_json)),
  content_sha256  TEXT NOT NULL CHECK (length(content_sha256) = 64),
  save_key        TEXT UNIQUE CHECK (save_key IS NULL OR length(save_key) = 36),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (draft_id, revision),
  CHECK ((revision = 1) = (origin = 'GENERATED'))
);

CREATE TRIGGER IF NOT EXISTS clarification_drafts_immutable BEFORE UPDATE ON clarification_drafts
BEGIN SELECT RAISE(ABORT, 'clarification drafts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS clarification_drafts_no_delete BEFORE DELETE ON clarification_drafts
BEGIN SELECT RAISE(ABORT, 'clarification drafts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS clarification_draft_revisions_immutable BEFORE UPDATE ON clarification_draft_revisions
BEGIN SELECT RAISE(ABORT, 'clarification draft revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS clarification_draft_revisions_no_delete BEFORE DELETE ON clarification_draft_revisions
BEGIN SELECT RAISE(ABORT, 'clarification draft revisions cannot be deleted'); END;
-- Revisions are numbered without gaps.
CREATE TRIGGER IF NOT EXISTS clarification_draft_revisions_chain BEFORE INSERT ON clarification_draft_revisions
WHEN NEW.revision <> coalesce((SELECT max(revision) FROM clarification_draft_revisions WHERE draft_id = NEW.draft_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'clarification draft revisions must be consecutive'); END;
`;
