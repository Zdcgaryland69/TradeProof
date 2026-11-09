// Runs before the procurement pages, sign-in and APIs are rendered. Local development tool: refused in production
// builds and for any non-loopback Host (the Host check blocks DNS rebinding; it is NOT authentication). Refusing here
// (not only inside the page) gives a real status — a page with a loading boundary has already streamed "200" by the
// time it calls notFound() / redirect() — and nothing downstream opens the database.
//
// 30 Oct: a request WITHOUT any session cookie is sent to /login (pages, 307) or refused (APIs, 401) here already.
// This is only an early exit: whether a presented cookie is a valid session is decided on the server by every page
// and route handler (src/server/auth), together with the object-level checks.

import type { NextRequest } from "next/server";

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const OPEN_PATHS = new Set(["/login", "/api/auth/login"]);

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  const refuse = (status: number, error: string) =>
    isApi
      ? Response.json({ ok: false, code: status === 401 ? "UNAUTHENTICATED" : undefined, error }, { status, headers: { "Cache-Control": "no-store" } })
      : new Response(status === 404 ? "Not found" : error, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

  if (process.env.NODE_ENV === "production") return refuse(404, "Not found");
  if (!LOCAL_HOST.test(request.headers.get("host") ?? "")) return refuse(403, "Procurement pages and API are local-only");
  if (path === "/sandbox-demo" || path.startsWith("/api/sandbox-demo")) return refuse(404, "Not found");
  if (!OPEN_PATHS.has(path) && !request.cookies.get("tp_session")?.value) {
    if (isApi) return refuse(401, "Sign in first.");
    const to = new URL("/login", request.url);
    to.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return Response.redirect(to, 307);
  }
  return undefined;
}

export const config = {
  matcher: ["/login", "/procurements", "/procurements/:path*", "/api/procurements", "/api/procurements/:path*", "/api/auth/:path*", "/sandbox-demo", "/api/sandbox-demo/:path*"],
};
