// Local-only guard shared by the development APIs (Sandbox payment demo, procurement drafts).
// There is no login yet, so these APIs must only be reachable from this machine in `next dev`.
// Plain Web `Request`/`Response`, no Next.js imports, so it is unit-testable.

export const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Same rule for page components, which only see the Host header. */
export const LOCAL_HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export interface LocalGuardOptions {
  enabled: boolean;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

/**
 * Disabled outside development (404), Host must be loopback (blocks DNS rebinding), and
 * state-changing requests must carry a same-origin loopback Origin header (blocks cross-site
 * form / fetch posts). Returns a refusal response, or null when the request may proceed.
 */
export function localOnlyGuard(req: Request, opts: LocalGuardOptions, label: string): Response | null {
  if (!opts.enabled) return json(404, { error: "Not found" });
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return json(403, { error: `${label} is local-only` });
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (!origin) return json(403, { error: "Missing Origin header" });
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return json(403, { error: "Bad Origin header" });
    }
    if (originUrl.host.toLowerCase() !== host.toLowerCase() || !LOCAL_HOSTNAMES.has(hostnameOf(originUrl.host))) {
      return json(403, { error: "Cross-origin request refused" });
    }
  }
  return null;
}

/** Development-only features (no login yet): never enabled in a production build. */
export function localDevFeaturesEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
