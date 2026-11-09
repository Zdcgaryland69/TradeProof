import "server-only";

import { headers } from "next/headers";
import type { Principal } from "@/server/access/policy";
import { requireSignedIn } from "@/server/auth";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LOCAL_HOST_HEADER } from "@/server/http/local-guard";
import { procurementEnabled } from "@/server/procurement";

/**
 * Procurement pages have no login yet: they render only in `next dev` and only for a loopback Host.
 * Call before touching the database, so a refused request never opens or creates it.
 */
export async function requireLocalDev(): Promise<void> {
  await connection(); // always rendered per request (reads the local DB)
  if (!procurementEnabled()) notFound();
  const host = (await headers()).get("host") ?? "";
  if (!LOCAL_HOST_HEADER.test(host)) notFound();
}

/** Local-only check, then the signed-in account (no session → /login). Pages then check access per request id. */
export async function requireSignedInPage(returnTo: string): Promise<Principal> {
  await requireLocalDev();
  return requireSignedIn(returnTo);
}
