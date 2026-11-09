// HTTP layer for sign-in (30 Oct). Local-only like every other API.
//
//   POST /api/auth/login    {username, password}  → sets tp_session (HttpOnly) + tp_csrf; one answer for any failure
//   POST /api/auth/logout                         → revokes the session on the server, clears both cookies
//   GET  /api/procurements/:id/approvers           owner: approver accounts with their assignment state
//   POST /api/procurements/:id/approvers           owner: {approverId, action: GRANT | REVOKE}
//                                                  429 ASSIGNMENT_RATE_LIMITED (+ Retry-After) on the 11th new GRANT in
//                                                  10 min; nothing changed, no automatic retry; REVOKE never limited
//
// Login has no session yet: it is protected by the same-origin Origin check and SameSite=Strict cookies; it accepts
// no other field. Logout and approver changes need the session and the CSRF token (guard()).

import { localOnlyGuard, type LocalGuardOptions } from "../http/local-guard.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import { guard, type GuardOptions } from "./gate.ts";
import { ASSIGN_LIMIT, ASSIGN_WINDOW_MS, clearedCookies, readCookie, SESSION_COOKIE, sessionCookies, type AuthService } from "./service.ts";

const json = (status: number, body: unknown, cookies: string[] = []) => {
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
};
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request." });

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleLogin(req: Request, auth: AuthService, opts: LocalGuardOptions): Promise<Response> {
  const blocked = localOnlyGuard(req, opts, "Sign-in");
  if (blocked) return blocked;
  const b = await body(req);
  if (!b || Object.keys(b).some((k) => k !== "username" && k !== "password")) return json(422, { ok: false, code: "VALIDATION_FAILED", message: "Send username and password only." });
  const out = await auth.login(b.username, b.password, readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  if (out.status === "LOCKED") return json(429, { ok: false, code: "TOO_MANY_ATTEMPTS", message: "Too many failed sign-ins for this name. Try again in 15 minutes." });
  if (out.status !== "OK") return json(401, { ok: false, code: "INVALID_LOGIN", message: "Username or password is wrong." });
  return json(200, { ok: true, user: { displayName: out.principal.displayName, role: out.principal.kind } }, sessionCookies(req, out.token, out.csrf));
}

export async function handleLogout(req: Request, auth: AuthService, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, "Sign-out");
  if (who instanceof Response) return who;
  auth.logout(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  return json(200, { ok: true }, clearedCookies(req));
}

export async function handleApprovers(req: Request, requestId: string, auth: AuthService, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, "Approver assignment");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId)) return notFound();
  if (req.method === "GET") {
    const state = who.kind === "BUYER" && who.access.ownerOf(requestId) === who.id ? auth.approverState(requestId) : null;
    return state ? json(200, { ok: true, approvers: state }) : notFound();
  }
  const b = await body(req);
  if (!b || Object.keys(b).some((k) => k !== "approverId" && k !== "action")) return json(422, { ok: false, code: "VALIDATION_FAILED", message: "Send approverId and action only." });
  const out = auth.setApprover(who, requestId, b.approverId, b.action);
  if (out.status === "NOT_FOUND") return notFound();
  if (out.status === "INVALID") return json(422, { ok: false, code: "VALIDATION_FAILED", message: out.message });
  if (out.status === "RATE_LIMITED") {
    const wait = out.retryAfterSeconds;
    const text = wait >= 60 ? `${Math.floor(wait / 60)} min ${wait % 60} s` : `${wait} s`;
    const res = json(429, {
      ok: false,
      code: "ASSIGNMENT_RATE_LIMITED",
      retryAfterSeconds: wait,
      message: `Too many approver assignments on this request: at most ${ASSIGN_LIMIT} in ${ASSIGN_WINDOW_MS / 60000} minutes. Nothing was changed. You can assign again in about ${text}. Removing an approver is never limited.`,
      approvers: auth.approverState(requestId),
    });
    res.headers.set("Retry-After", String(wait));
    return res;
  }
  return json(200, { ok: true, status: out.status, approvers: auth.approverState(requestId) });
}
