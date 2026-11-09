// The one entry check of every API handler (30 Oct): local-only guard (loopback Host, same-origin Origin on writes —
// NOT authentication), then the signed-in principal from the session cookie (401 without one), then the CSRF token
// on every state-changing request (403). Object-level checks follow in the handler / service via policy.ts.

import type { Principal } from "../access/policy.ts";
import { localOnlyGuard, type LocalGuardOptions } from "../http/local-guard.ts";
import { CSRF_HEADER, readCookie, SESSION_COOKIE } from "./service.ts";

/** What a handler needs from authentication. Production: AuthService (cookies). Tests that are not about access pass a fixed test principal. */
export interface AuthGate {
  resolve(sessionToken: string | null): Principal | null;
  csrfOk(principal: Principal, sent: string | null): boolean;
}

export interface GuardOptions extends LocalGuardOptions {
  auth: AuthGate;
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function guard(req: Request, opts: GuardOptions, label: string): Principal | Response {
  const blocked = localOnlyGuard(req, opts, label);
  if (blocked) return blocked;
  const principal = opts.auth.resolve(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  if (!principal) return json(401, { ok: false, code: "UNAUTHENTICATED", message: "Sign in first." });
  if (req.method !== "GET" && req.method !== "HEAD" && !opts.auth.csrfOk(principal, req.headers.get(CSRF_HEADER))) {
    return json(403, { ok: false, code: "CSRF", message: "Missing or wrong CSRF token. Reload the page and try again." });
  }
  return principal;
}
