// Browser side of the CSRF protection (30 Oct, docs/access-control.md): every state-changing API request sends the
// session's CSRF token, which the server set in the readable `tp_csrf` cookie at sign-in, in this header. The
// session token itself is HttpOnly and never readable here; nothing is kept in localStorage.

export const CSRF_HEADER_NAME = "X-TradeProof-CSRF";

export function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const m = /(?:^|;\s*)tp_csrf=([^;]*)/.exec(document.cookie);
  return m && m[1] ? { [CSRF_HEADER_NAME]: decodeURIComponent(m[1]) } : {};
}
