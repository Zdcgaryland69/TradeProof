// Sign-in, sessions, CSRF tokens, approver assignment and audit (30 Oct, schema v15; docs/access-control.md).
//
// - login: one answer for unknown user and wrong password (same scrypt work); after MAX_FAILURES failures for a name
//   within the window, further attempts for that name are refused until it passes. A new session is created on every
//   login and a session the browser already presented is revoked (no fixation).
// - sessions: random 32-byte token, only its SHA-256 stored; absolute and idle expiry; logout revokes on the server.
// - CSRF: a second random token per session, also stored as SHA-256; every state-changing API request must send it
//   in a header (compared by hash, constant time). Same-origin Origin is checked separately by the local guard.
// - assign / revoke approver: owner only, append-only rows, audited.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canAssignApprover, type Principal, type Role } from "../access/policy.ts";
import { dummyHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.ts";
import { ACCOUNT_USERNAME, type Account, type AuditEntry, type AuthStore, type GrantRow } from "./store.ts";

export const SESSION_COOKIE = "tp_session";
export const CSRF_COOKIE = "tp_csrf";
export const CSRF_HEADER = "x-tradeproof-csrf";
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 60 * 60 * 1000;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;
/** Short-time approver assignment limit (3 Nov): new GRANTs per buyer and request in a rolling window. Removal: none. */
export const ASSIGN_LIMIT = 10;
export const ASSIGN_WINDOW_MS = 10 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nameHash = (username: string) => `uh_${sha256(`login-name\n${username.trim().toLowerCase()}`).slice(0, 32)}`;
const token = () => randomBytes(32).toString("base64url");

export type LoginOutcome = { status: "OK"; token: string; csrf: string; principal: Principal } | { status: "INVALID" } | { status: "LOCKED" };

export class AuthService {
  readonly store: AuthStore;
  private readonly now: () => Date;

  constructor(store: AuthStore, opts: { now?: () => Date } = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date());
  }

  audit(e: AuditEntry): void {
    this.store.audit(e);
  }

  private principalFor(a: Account, sessionId: string | null): Principal {
    return { kind: a.role, id: a.id, username: a.username, displayName: a.displayName, sessionId, access: this.store };
  }

  /** An account acting outside a browser session (local operator scripts only, e.g. the demo seed). */
  principalOfAccount(username: string): Principal | null {
    const a = this.store.accountByUsername(username);
    return a ? this.principalFor(a, null) : null;
  }

  /** Local operator only (npm run accounts:setup). Never overwrites an existing account; no empty or short password. */
  async createAccount(username: string, role: Role, displayName: string, password: string): Promise<"CREATED" | "EXISTS"> {
    const name = username.trim().toLowerCase();
    if (!ACCOUNT_USERNAME.test(name)) throw new Error("invalid username");
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must have at least ${MIN_PASSWORD_LENGTH} characters`);
    if (this.store.accountByUsername(name)) return "EXISTS";
    const out = this.store.insertAccount({ username: name, role, displayName, passwordHash: await hashPassword(password) });
    this.audit({ action: out === "CREATED" ? "ACCOUNT_CREATED" : "ACCOUNT_EXISTS", objectType: "PRINCIPAL", objectId: name, outcome: "OK", detail: { role } });
    return out;
  }

  /**
   * Local operator only (npm run accounts:reset-password). Replaces the password of an EXISTING account (no account is
   * created or deleted) and revokes all its sessions. The new password must have MIN_PASSWORD_LENGTH characters and
   * differ from the current one.
   */
  async resetPassword(username: string, newPassword: string): Promise<{ status: "RESET"; revokedSessions: number } | { status: "NOT_FOUND" | "TOO_SHORT" | "SAME_AS_CURRENT" }> {
    const account = this.store.accountByUsername(username.trim().toLowerCase());
    if (!account) return { status: "NOT_FOUND" };
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) return { status: "TOO_SHORT" };
    if (await verifyPassword(newPassword, account.passwordHash)) return { status: "SAME_AS_CURRENT" };
    const out = this.store.resetPassword(account.id, await hashPassword(newPassword));
    return { status: "RESET", revokedSessions: out.revokedSessions };
  }

  async login(username: unknown, password: unknown, presentedToken: string | null): Promise<LoginOutcome> {
    const name = typeof username === "string" ? username.trim().toLowerCase().slice(0, 80) : "";
    const pass = typeof password === "string" ? password.slice(0, 1024) : "";
    const nh = nameHash(name);
    const since = new Date(this.now().getTime() - FAILURE_WINDOW_MS).toISOString();
    if (this.store.recentFailures(nh, since) >= MAX_FAILURES) {
      this.audit({ action: "LOGIN", objectType: "LOGIN_NAME", objectId: nh, outcome: "DENIED", detail: { reason: "TOO_MANY_FAILURES" } });
      return { status: "LOCKED" };
    }
    const account = name ? this.store.accountByUsername(name) : null;
    const ok = await verifyPassword(pass, account?.passwordHash ?? (await dummyHash()));
    if (!account || !ok || pass === "") {
      this.audit({ action: "LOGIN", objectType: "LOGIN_NAME", objectId: nh, outcome: "FAILED" });
      return { status: "INVALID" };
    }
    if (presentedToken) {
      const old = this.store.sessionByTokenHash(sha256(presentedToken));
      if (old && !old.revokedAt) this.store.revokeSession(old.id, "REPLACED_BY_LOGIN");
    }
    const t = token();
    const c = token();
    const sessionId = this.store.insertSession({ principalId: account.id, tokenSha256: sha256(t), csrfSha256: sha256(c), expiresAt: new Date(this.now().getTime() + SESSION_ABSOLUTE_MS).toISOString() });
    this.audit({ actorId: account.id, actorRole: account.role, action: "LOGIN", objectType: "LOGIN_NAME", objectId: nh, outcome: "OK", detail: { session: sessionId } });
    return { status: "OK", token: t, csrf: c, principal: this.principalFor(account, sessionId) };
  }

  /** The signed-in principal for a session token, or null (unknown, revoked, expired or idle). */
  resolve(sessionToken: string | null | undefined): Principal | null {
    if (!sessionToken || sessionToken.length > 200) return null;
    const s = this.store.sessionByTokenHash(sha256(sessionToken));
    if (!s || s.revokedAt) return null;
    const now = this.now().getTime();
    if (now >= Date.parse(s.expiresAt)) {
      this.store.revokeSession(s.id, "EXPIRED");
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) >= SESSION_IDLE_MS) {
      this.store.revokeSession(s.id, "IDLE");
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) >= TOUCH_EVERY_MS) this.store.touchSession(s.id, new Date(now).toISOString());
    const a = this.store.account(s.principalId);
    return a ? this.principalFor(a, s.id) : null;
  }

  /** The CSRF token sent with a state-changing request matches this session's (constant-time on the hashes). */
  csrfOk(principal: Principal, sent: string | null): boolean {
    if (!principal.sessionId || !sent || sent.length > 200) return false;
    const stored = this.store.sessionCsrf(principal.sessionId);
    if (!stored) return false;
    return timingSafeEqual(Buffer.from(sha256(sent), "hex"), Buffer.from(stored, "hex"));
  }

  logout(sessionToken: string | null): boolean {
    if (!sessionToken) return false;
    const s = this.store.sessionByTokenHash(sha256(sessionToken));
    if (!s || s.revokedAt) return false;
    const done = this.store.revokeSession(s.id, "LOGOUT");
    this.audit({ actorId: s.principalId, action: "LOGOUT", objectType: "SESSION", objectId: s.id, outcome: done ? "OK" : "FAILED" });
    return done;
  }

  // ---------- approver assignment ----------

  approvers(): { id: string; displayName: string; username: string }[] {
    return this.store.accounts("APPROVER").map((a) => ({ id: a.id, displayName: a.displayName, username: a.username }));
  }

  approverState(requestId: string): { approverId: string; displayName: string; assigned: boolean; history: GrantRow[] }[] {
    const grants = this.store.grants(requestId);
    return this.approvers().map((a) => ({ approverId: a.id, displayName: a.displayName, assigned: this.store.isAssignedApprover(requestId, a.id), history: grants.filter((g) => g.approverId === a.id) }));
  }

  /**
   * Owner grants or revokes an approver. NOT_FOUND hides requests the caller does not own.
   *
   * Short-time assignment limit (3 Nov, owner decision): at most ASSIGN_LIMIT real new GRANTs by the same buyer on the
   * same request within a rolling ASSIGN_WINDOW_MS. Counted from the persisted grant rows inside the same BEGIN IMMEDIATE
   * transaction as the insert (no over-allocation under concurrent requests; survives a restart). A repeated GRANT
   * (already assigned) is UNCHANGED before the check and costs nothing; a refused request writes no grant row. REVOKE is
   * never checked against the limit — removing an approver is never blocked or delayed. No cumulative cap. Approval
   * validity still uses grant seq only; the time here only decides the window: a backwards clock step can make the
   * wait longer (only assigning is affected), a forward step shorter.
   */
  setApprover(principal: Principal, requestId: string, approverId: unknown, action: unknown): { status: "NOT_FOUND" } | { status: "INVALID"; message: string } | { status: "RATE_LIMITED"; retryAfterSeconds: number } | { status: "UNCHANGED" | "CHANGED"; grant: GrantRow | null } {
    if (!canAssignApprover(principal, requestId)) {
      this.audit({ actorId: principal.id, actorRole: principal.kind, action: "APPROVER_ASSIGN", objectType: "REQUEST", objectId: requestId, outcome: "DENIED" });
      return { status: "NOT_FOUND" };
    }
    if (action !== "GRANT" && action !== "REVOKE") return { status: "INVALID", message: "action must be GRANT or REVOKE." };
    const approver = typeof approverId === "string" ? this.store.account(approverId) : null;
    if (!approver || approver.role !== "APPROVER") return { status: "INVALID", message: "approverId must name an approver account." };
    return this.store.transaction(() => {
      const assigned = this.store.isAssignedApprover(requestId, approver.id);
      if ((action === "GRANT") === assigned) return { status: "UNCHANGED" as const, grant: null };
      if (action === "GRANT") {
        const now = this.now().getTime();
        const recent = this.store.recentGrantTimes(requestId, principal.id, new Date(now - ASSIGN_WINDOW_MS).toISOString());
        if (recent.length >= ASSIGN_LIMIT) {
          // The window frees a place when enough of the counted grants have aged out of it.
          const freesAt = Date.parse(recent[recent.length - ASSIGN_LIMIT]) + ASSIGN_WINDOW_MS;
          const retryAfterSeconds = Math.max(1, Math.ceil((freesAt - now) / 1000));
          this.audit({ actorId: principal.id, actorRole: principal.kind, action: "APPROVER_ASSIGN", objectType: "REQUEST", objectId: requestId, outcome: "DENIED", detail: { reason: "RATE_LIMITED", approver: approver.id, retryAfterSeconds } });
          return { status: "RATE_LIMITED" as const, retryAfterSeconds };
        }
      }
      const grant = this.store.insertGrant(requestId, approver.id, action, principal.id);
      this.audit({ actorId: principal.id, actorRole: principal.kind, action: action === "GRANT" ? "APPROVER_GRANTED" : "APPROVER_REVOKED", objectType: "REQUEST", objectId: requestId, outcome: "OK", detail: { approver: approver.id, seq: grant.seq } });
      return { status: "CHANGED" as const, grant };
    });
  }
}

// ---------- cookies ----------

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Secure only over HTTPS (or in production); a local http://127.0.0.1 demo cannot use Secure cookies. */
export function cookieSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production";
}

export function sessionCookies(req: Request, sessionToken: string, csrfToken: string): string[] {
  const secure = cookieSecure(req) ? "; Secure" : "";
  const maxAge = Math.floor(SESSION_ABSOLUTE_MS / 1000);
  return [`${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`, `${CSRF_COOKIE}=${csrfToken}; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`];
}

export function clearedCookies(req: Request): string[] {
  const secure = cookieSecure(req) ? "; Secure" : "";
  return [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`, `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`];
}
