// Accounts, sessions, ownership, approver grants and the access audit (schema v15) on the shared local SQLite file.
// Also the server-side AccessLookup behind policy.ts: who owns a request, whether an approver is currently assigned,
// and the SQL scope for lists and search.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, type OpenOptions } from "../db/database.ts";
import type { AccessLookup, Principal, Role } from "../access/policy.ts";

type Row = Record<string, unknown>;

export interface Account {
  id: string;
  username: string;
  role: Role;
  displayName: string;
  passwordHash: string;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  principalId: string;
  csrfSha256: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface GrantRow {
  seq: number;
  requestId: string;
  approverId: string;
  action: "GRANT" | "REVOKE";
  actorId: string;
  createdAt: string;
}

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: Role | null;
  action: string;
  objectType?: string | null;
  objectId?: string | null;
  outcome: "OK" | "DENIED" | "FAILED";
  detail?: Record<string, unknown>;
}

const toAccount = (r: Row): Account => ({
  id: String(r.id),
  username: String(r.username),
  role: r.role as Role,
  displayName: String(r.display_name),
  passwordHash: String(r.password_hash),
  createdAt: String(r.created_at),
});

export const ACCOUNT_USERNAME = /^[a-z][a-z0-9-]{2,39}$/;

export class AuthStore implements AccessLookup {
  private readonly db: DatabaseSync;
  private readonly nowIso: () => string;

  constructor(filePath: string, options?: OpenOptions & { now?: () => Date }) {
    this.db = openDatabase(filePath, options);
    this.nowIso = () => (options?.now ? options.now() : new Date()).toISOString();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- accounts ----------

  accountByUsername(username: string): Account | null {
    const r = this.db.prepare("SELECT * FROM principals WHERE username = ?").get(username.toLowerCase()) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  account(id: string): Account | null {
    const r = this.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  accounts(role?: Role): Account[] {
    const rows = (role ? this.db.prepare("SELECT * FROM principals WHERE role = ? ORDER BY username").all(role) : this.db.prepare("SELECT * FROM principals ORDER BY username").all()) as Row[];
    return rows.map(toAccount);
  }

  /** Inserts an account unless the username exists (never overwrites). */
  insertAccount(a: { username: string; role: Role; displayName: string; passwordHash: string }): "CREATED" | "EXISTS" {
    return this.transaction(() => {
      if (this.accountByUsername(a.username)) return "EXISTS";
      this.db
        .prepare("INSERT INTO principals (id, username, role, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`u_${randomUUID()}`, a.username.toLowerCase(), a.role, a.displayName, a.passwordHash, this.nowIso());
      return "CREATED";
    });
  }

  // ---------- sessions ----------

  insertSession(s: { principalId: string; tokenSha256: string; csrfSha256: string; expiresAt: string }): string {
    const id = `ss_${randomUUID()}`;
    const now = this.nowIso();
    this.db
      .prepare("INSERT INTO sessions (id, principal_id, token_sha256, csrf_sha256, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, s.principalId, s.tokenSha256, s.csrfSha256, now, now, s.expiresAt);
    return id;
  }

  sessionByTokenHash(tokenSha256: string): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_sha256 = ?").get(tokenSha256) as Row | undefined;
    return r
      ? {
          id: String(r.id),
          principalId: String(r.principal_id),
          csrfSha256: String(r.csrf_sha256),
          createdAt: String(r.created_at),
          lastSeenAt: String(r.last_seen_at),
          expiresAt: String(r.expires_at),
          revokedAt: (r.revoked_at as string | null) ?? null,
        }
      : null;
  }

  sessionCsrf(sessionId: string): string | null {
    const r = this.db.prepare("SELECT csrf_sha256, revoked_at FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
    return r && r.revoked_at === null ? String(r.csrf_sha256) : null;
  }

  touchSession(id: string, at: string): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  }

  revokeSession(id: string, reason: "LOGOUT" | "REPLACED_BY_LOGIN" | "EXPIRED" | "IDLE" | "PASSWORD_RESET"): boolean {
    return Number(this.db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL").run(this.nowIso(), reason, id).changes) === 1;
  }

  /**
   * Local password reset (schema v16): replaces the hash and revokes every open session of this account, in one
   * transaction. Id, username, role, display name, ownership, grants and history are not touched.
   */
  resetPassword(principalId: string, passwordHash: string): { revokedSessions: number } {
    return this.transaction(() => {
      const changed = Number(this.db.prepare("UPDATE principals SET password_hash = ? WHERE id = ?").run(passwordHash, principalId).changes);
      if (changed !== 1) throw new Error("account not found");
      const revoked = Number(this.db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'PASSWORD_RESET' WHERE principal_id = ? AND revoked_at IS NULL").run(this.nowIso(), principalId).changes);
      this.audit({ actorId: null, actorRole: null, action: "PASSWORD_RESET", objectType: "PRINCIPAL", objectId: principalId, outcome: "OK", detail: { revokedSessions: revoked, by: "LOCAL_OPERATOR_SCRIPT" } });
      return { revokedSessions: revoked };
    });
  }

  // ---------- ownership and grants (AccessLookup) ----------

  ownerOf(requestId: string): string | null {
    const r = this.db.prepare("SELECT principal_id FROM procurement_owners WHERE request_id = ?").get(requestId) as Row | undefined;
    return r ? String(r.principal_id) : null;
  }

  /** Operator seed only (requests created through the app get their owner inside ProcurementStore.create). */
  insertOwner(requestId: string, principalId: string, source: "CREATED_BY_BUYER" | "OPERATOR_SEED"): void {
    this.db.prepare("INSERT INTO procurement_owners (request_id, principal_id, source, created_at) VALUES (?, ?, ?, ?)").run(requestId, principalId, source, this.nowIso());
  }

  grants(requestId: string): GrantRow[] {
    return (this.db.prepare("SELECT * FROM approver_grants WHERE request_id = ? ORDER BY seq").all(requestId) as Row[]).map((r) => ({
      seq: Number(r.seq),
      requestId: String(r.request_id),
      approverId: String(r.approver_id),
      action: r.action as "GRANT" | "REVOKE",
      actorId: String(r.actor_id),
      createdAt: String(r.created_at),
    }));
  }

  isAssignedApprover(requestId: string, approverId: string): boolean {
    const r = this.db.prepare("SELECT action FROM approver_grants WHERE request_id = ? AND approver_id = ? ORDER BY seq DESC LIMIT 1").get(requestId, approverId) as Row | undefined;
    return r?.action === "GRANT";
  }

  /**
   * Times (created_at, oldest first) of the GRANT rows this actor wrote on this request after `sinceIso` — the short-time
   * assignment limit (3 Nov). Only real changes have rows (UNCHANGED writes none; refusals write none); REVOKE rows are
   * not counted. Read inside the caller's write transaction so the count and the insert are atomic.
   */
  recentGrantTimes(requestId: string, actorId: string, sinceIso: string): string[] {
    return (this.db.prepare("SELECT created_at FROM approver_grants WHERE request_id = ? AND actor_id = ? AND action = 'GRANT' AND created_at > ? ORDER BY created_at, seq").all(requestId, actorId, sinceIso) as Row[]).map((r) => String(r.created_at));
  }

  insertGrant(requestId: string, approverId: string, action: "GRANT" | "REVOKE", actorId: string): GrantRow {
    this.db.prepare("INSERT INTO approver_grants (request_id, approver_id, action, actor_id, created_at) VALUES (?, ?, ?, ?, ?)").run(requestId, approverId, action, actorId, this.nowIso());
    return this.grants(requestId).at(-1)!;
  }

  scope(principal: Principal, alias: string): { sql: string; params: string[] } {
    if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid alias");
    if (principal.kind === "BUYER") return { sql: `${alias}.id IN (SELECT o.request_id FROM procurement_owners o WHERE o.principal_id = ?)`, params: [principal.id] };
    return {
      sql: `${alias}.id IN (SELECT g.request_id FROM approver_grants g WHERE g.approver_id = ? AND g.action = 'GRANT' AND g.seq = (SELECT max(g2.seq) FROM approver_grants g2 WHERE g2.request_id = g.request_id AND g2.approver_id = g.approver_id))`,
      params: [principal.id],
    };
  }

  // ---------- audit ----------

  audit(e: AuditEntry): void {
    this.db
      .prepare("INSERT INTO access_audit (at, actor_id, actor_role, action, object_type, object_id, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.nowIso(), e.actorId ?? null, e.actorRole ?? null, e.action, e.objectType ?? null, e.objectId ?? null, e.outcome, JSON.stringify(e.detail ?? {}).slice(0, 2000));
  }

  /** Failed logins for this name-hash since its last successful login, within the window. */
  recentFailures(nameHash: string, sinceIso: string): number {
    const lastOk = this.db.prepare("SELECT max(seq) AS s FROM access_audit WHERE action = 'LOGIN' AND outcome = 'OK' AND object_id = ?").get(nameHash) as Row;
    return Number(
      (this.db
        .prepare("SELECT count(*) AS n FROM access_audit WHERE action = 'LOGIN' AND outcome = 'FAILED' AND object_id = ? AND at >= ? AND seq > ?")
        .get(nameHash, sinceIso, Number(lastOk.s ?? 0)) as Row).n,
    );
  }

  auditFor(objectType: string, objectId: string): { at: string; actorId: string | null; action: string; outcome: string; detail: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT * FROM access_audit WHERE object_type = ? AND object_id = ? ORDER BY seq").all(objectType, objectId) as Row[]).map((r) => ({
      at: String(r.at),
      actorId: (r.actor_id as string | null) ?? null,
      action: String(r.action),
      outcome: String(r.outcome),
      detail: JSON.parse(String(r.detail)),
    }));
  }
}
