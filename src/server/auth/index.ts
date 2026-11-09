// Server-only entry point for sign-in: the AuthService on the app's database, and the page helper.
import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Principal } from "../access/policy.ts";
import { APP_DB_PATH } from "../db/location.ts";
import { LOCAL_HOST_HEADER, localDevFeaturesEnabled } from "../http/local-guard.ts";
import { SESSION_COOKIE, AuthService } from "./service.ts";
import { AuthStore } from "./store.ts";

// Opened lazily; kept on globalThis so dev hot-reloads reuse one connection.
const holder = globalThis as typeof globalThis & { __tradeproofAuth?: AuthService };

export function getAuthService(): AuthService {
  holder.__tradeproofAuth ??= new AuthService(new AuthStore(APP_DB_PATH, { onBackup: (file) => console.info(`[db] backup written before migration: ${file}`) }));
  return holder.__tradeproofAuth;
}

/** Route handlers pass this as `auth` (resolves the session cookie, checks the CSRF header). */
export const getAuthGate = getAuthService;

/** The signed-in principal of the current page request, or null. Local-only like the pages themselves. */
export async function currentPrincipal(): Promise<Principal | null> {
  await connection();
  if (!localDevFeaturesEnabled()) return null;
  const host = (await headers()).get("host") ?? "";
  if (!LOCAL_HOST_HEADER.test(host)) return null;
  return getAuthService().resolve((await cookies()).get(SESSION_COOKIE)?.value ?? null);
}

/** Pages call this first: no session → /login (with a safe local return path). */
export async function requireSignedIn(returnTo: string): Promise<Principal> {
  const p = await currentPrincipal();
  if (!p) redirect(`/login?next=${encodeURIComponent(returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/")}`);
  return p;
}
