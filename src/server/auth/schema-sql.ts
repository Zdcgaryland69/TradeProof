// Sign-in and object-level access (30 Oct, schema v15). Design: docs/access-control.md.
//
// - principals: the preset demo accounts. Created only by the local operator script; never overwritten by it. (v16:
//   the password hash can be changed by the local reset script; every other column stays immutable.) The password is stored only as a scrypt hash string (salt and parameters inside).
// - sessions: server-side sessions. Only SHA-256 hashes of the session and CSRF tokens are stored. last_seen_at and
//   the revocation columns are the only columns that change; rows are never deleted.
// - procurement_owners: request → owning buyer. Immutable (no ownership transfer). Existing requests get no row.
// - approver_grants: append-only GRANT / REVOKE of an approver on a request, by the owning buyer.
// - access_audit: append-only decisions and security events (never passwords, tokens or quote / reply text).
// No existing table or row is touched and nothing is back-filled.

export const ACCESS_SCHEMA_V15 = `
CREATE TABLE IF NOT EXISTS principals (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'u_*'),
  username       TEXT NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 40),
  role           TEXT NOT NULL CHECK (role IN ('BUYER', 'APPROVER')),
  display_name   TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash  TEXT NOT NULL CHECK (password_hash GLOB 'scrypt$*'),
  created_at     TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS principals_immutable BEFORE UPDATE ON principals
BEGIN SELECT RAISE(ABORT, 'principals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS principals_no_delete BEFORE DELETE ON principals
BEGIN SELECT RAISE(ABORT, 'principals cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'ss_*'),
  principal_id   TEXT NOT NULL REFERENCES principals(id),
  token_sha256   TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  csrf_sha256    TEXT NOT NULL CHECK (length(csrf_sha256) = 64),
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  revoke_reason  TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('LOGOUT', 'REPLACED_BY_LOGIN', 'EXPIRED', 'IDLE'))
);
CREATE INDEX IF NOT EXISTS sessions_by_principal ON sessions(principal_id);
CREATE TRIGGER IF NOT EXISTS sessions_fixed_columns BEFORE UPDATE OF id, principal_id, token_sha256, csrf_sha256, created_at, expires_at ON sessions
BEGIN SELECT RAISE(ABORT, 'session identity columns are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sessions_revocation_final BEFORE UPDATE OF revoked_at ON sessions WHEN OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a revoked session stays revoked'); END;
CREATE TRIGGER IF NOT EXISTS sessions_no_delete BEFORE DELETE ON sessions
BEGIN SELECT RAISE(ABORT, 'sessions are kept'); END;

CREATE TABLE IF NOT EXISTS procurement_owners (
  request_id     TEXT PRIMARY KEY REFERENCES procurement_requests(id),
  principal_id   TEXT NOT NULL REFERENCES principals(id),
  source         TEXT NOT NULL CHECK (source IN ('CREATED_BY_BUYER', 'OPERATOR_SEED')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS procurement_owners_by_principal ON procurement_owners(principal_id);
CREATE TRIGGER IF NOT EXISTS procurement_owners_immutable BEFORE UPDATE ON procurement_owners
BEGIN SELECT RAISE(ABORT, 'ownership is immutable'); END;
CREATE TRIGGER IF NOT EXISTS procurement_owners_no_delete BEFORE DELETE ON procurement_owners
BEGIN SELECT RAISE(ABORT, 'ownership cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS approver_grants (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     TEXT NOT NULL REFERENCES procurement_requests(id),
  approver_id    TEXT NOT NULL REFERENCES principals(id),
  action         TEXT NOT NULL CHECK (action IN ('GRANT', 'REVOKE')),
  actor_id       TEXT NOT NULL REFERENCES principals(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approver_grants_by_request ON approver_grants(request_id, approver_id, seq);
CREATE TRIGGER IF NOT EXISTS approver_grants_immutable BEFORE UPDATE ON approver_grants
BEGIN SELECT RAISE(ABORT, 'approver grants are append-only'); END;
CREATE TRIGGER IF NOT EXISTS approver_grants_no_delete BEFORE DELETE ON approver_grants
BEGIN SELECT RAISE(ABORT, 'approver grants are append-only'); END;

CREATE TABLE IF NOT EXISTS access_audit (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor_id       TEXT,
  actor_role     TEXT CHECK (actor_role IS NULL OR actor_role IN ('BUYER', 'APPROVER')),
  action         TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 60),
  object_type    TEXT,
  object_id      TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('OK', 'DENIED', 'FAILED')),
  detail         TEXT NOT NULL DEFAULT '{}' CHECK (length(detail) <= 2000)
);
CREATE INDEX IF NOT EXISTS access_audit_by_action ON access_audit(action, at);
CREATE TRIGGER IF NOT EXISTS access_audit_immutable BEFORE UPDATE ON access_audit
BEGIN SELECT RAISE(ABORT, 'audit rows are append-only'); END;
CREATE TRIGGER IF NOT EXISTS access_audit_no_delete BEFORE DELETE ON access_audit
BEGIN SELECT RAISE(ABORT, 'audit rows are append-only'); END;
`;

// v16 (30 Oct night): local password reset by the operator (scripts/reset-password.mjs). The password hash becomes the
// ONLY changeable column of a principal (id, username, role, display name and creation time stay immutable; no
// delete). Sessions get the revocation reason PASSWORD_RESET; SQLite cannot alter a CHECK constraint, so the sessions
// table is rebuilt with every row copied unchanged (the runner turns foreign keys off around the transaction and
// checks them before COMMIT). Nothing else is touched.
export const ACCESS_SCHEMA_V16 = `
DROP TRIGGER IF EXISTS principals_immutable;
CREATE TRIGGER IF NOT EXISTS principals_fixed_columns BEFORE UPDATE OF id, username, role, display_name, created_at ON principals
BEGIN SELECT RAISE(ABORT, 'only the password hash of a principal can change'); END;

DROP TRIGGER IF EXISTS sessions_fixed_columns;
DROP TRIGGER IF EXISTS sessions_revocation_final;
DROP TRIGGER IF EXISTS sessions_no_delete;
DROP INDEX IF EXISTS sessions_by_principal;
ALTER TABLE sessions RENAME TO sessions_v15;
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'ss_*'),
  principal_id   TEXT NOT NULL REFERENCES principals(id),
  token_sha256   TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  csrf_sha256    TEXT NOT NULL CHECK (length(csrf_sha256) = 64),
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  revoke_reason  TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('LOGOUT', 'REPLACED_BY_LOGIN', 'EXPIRED', 'IDLE', 'PASSWORD_RESET'))
);
INSERT INTO sessions (id, principal_id, token_sha256, csrf_sha256, created_at, last_seen_at, expires_at, revoked_at, revoke_reason)
  SELECT id, principal_id, token_sha256, csrf_sha256, created_at, last_seen_at, expires_at, revoked_at, revoke_reason FROM sessions_v15;
DROP TABLE sessions_v15;
CREATE INDEX IF NOT EXISTS sessions_by_principal ON sessions(principal_id);
CREATE TRIGGER IF NOT EXISTS sessions_fixed_columns BEFORE UPDATE OF id, principal_id, token_sha256, csrf_sha256, created_at, expires_at ON sessions
BEGIN SELECT RAISE(ABORT, 'session identity columns are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sessions_revocation_final BEFORE UPDATE OF revoked_at ON sessions WHEN OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a revoked session stays revoked'); END;
CREATE TRIGGER IF NOT EXISTS sessions_no_delete BEFORE DELETE ON sessions
BEGIN SELECT RAISE(ABORT, 'sessions are kept'); END;
`;
