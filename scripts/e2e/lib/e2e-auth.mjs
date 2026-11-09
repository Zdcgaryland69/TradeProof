// Real sign-in for the browser checks (30 Oct, after access control). No bypass: every script signs in through the
// app's own POST /api/auth/login and then carries the returned cookies (session HttpOnly + CSRF), exactly like a user.
//
// - Browser checks run ONLY on a database COPY (E2E_DB); the main file is refused.
// - Each run creates its OWN accounts in that copy (e2e-buyer-<hex>, e2e-approver-<hex>) with random passwords held
//   only in this process (never printed or written); real demo accounts and their passwords are never used.
// - Records a script seeds directly are created with the e2e buyer as owner (source OPERATOR_SEED, like the demo
//   seed); records created through the UI / API get their owner from the session, as for any user.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(join(root, p)).href);

/** The database copy every browser check must use (E2E_DB). Exits on the main database or a missing file. */
export function e2eDb() {
  const main = resolve(root, "data", "sandbox-payments.sqlite");
  const db = process.env.E2E_DB ? resolve(process.env.E2E_DB) : null;
  if (!db || db.toLowerCase() === main.toLowerCase() || !existsSync(db)) {
    console.error("E2E_DB must name an existing database COPY (never data/sandbox-payments.sqlite); the dev server must run with TRADEPROOF_DB_PATH=<same copy>.");
    process.exit(2);
  }
  return db;
}

/** Fresh per-run accounts in the copy. Returns usernames, ids, passwords (memory only) and real principals for seeding. */
export async function e2eAccounts(db) {
  const [{ AuthStore }, { AuthService }] = await Promise.all([load("src/server/auth/store.ts"), load("src/server/auth/service.ts")]);
  const tag = randomBytes(3).toString("hex");
  const store = new AuthStore(db);
  const auth = new AuthService(store);
  const out = {};
  try {
    for (const [key, username, role, name] of [
      ["buyer", `e2e-buyer-${tag}`, "BUYER", `E2E buyer ${tag}`],
      ["buyer2", `e2e-buyer2-${tag}`, "BUYER", `E2E buyer 2 ${tag}`],
      ["approver", `e2e-approver-${tag}`, "APPROVER", `E2E approver ${tag}`],
    ]) {
      const password = randomBytes(15).toString("base64url");
      await auth.createAccount(username, role, name, password);
      const p = auth.principalOfAccount(username);
      out[key] = { username, password, id: p.id, displayName: name };
    }
  } finally {
    store.close();
  }
  return out;
}

/** Sign in through the app. Returns the cookies as the browser would get them. */
export async function login(base, account) {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ username: account.username, password: account.password }) });
  if (res.status !== 200) throw new Error(`login ${account.username} → HTTP ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), httpOnly: /;\s*HttpOnly/i.test(c) };
  });
  const csrf = cookies.find((c) => c.name === "tp_csrf")?.value ?? "";
  return { account, cookies, csrf, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

/** fetch() as that signed-in user: session cookie, same-origin Origin and the CSRF header on writes. */
export function authedFetch(base, session, path, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = { ...(init.headers ?? {}), Cookie: session.cookie, ...(method === "GET" ? {} : { Origin: base, "X-TradeProof-CSRF": session.csrf }) };
  return fetch(`${base}${path}`, { ...init, headers });
}

/** Put the session cookies into an Edge profile (DevTools port) — the browser is then signed in for every tab. */
export async function signInBrowser(port, base, session) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let seq = 0;
  const call = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const onMsg = (e) => {
        const m = JSON.parse(e.data);
        if (m.id !== id) return;
        ws.removeEventListener("message", onMsg);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  for (const c of session.cookies) await call("Network.setCookie", { name: c.name, value: c.value, url: base, httpOnly: c.httpOnly, sameSite: "Strict" });
  ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
}

/** Owner assigns an approver (through the app's API, as the buyer). */
export async function grantApprover(base, buyerSession, requestId, approverId) {
  const res = await authedFetch(base, buyerSession, `/api/procurements/${requestId}/approvers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approverId, action: "GRANT" }) });
  if (res.status !== 200) throw new Error(`grant approver → HTTP ${res.status}`);
}

/** A real principal (server lookup) for direct seeding into the copy. */
export async function principalOf(db, username) {
  const [{ AuthStore }, { AuthService }] = await Promise.all([load("src/server/auth/store.ts"), load("src/server/auth/service.ts")]);
  const store = new AuthStore(db);
  const p = new AuthService(store).principalOfAccount(username);
  return { principal: p, close: () => store.close() };
}

/**
 * One call for a script: a signed-in buyer session in the browser at `port`. The first run of a script creates fresh
 * accounts and signs in; it keeps the session cookies (of these throwaway test accounts in the COPY only) in
 * `<copy>.e2e-session.json` next to the copy, outside the repository, so a later `--verify` run after a dev-server
 * restart can continue as the same buyer. No password is stored.
 */
export async function e2eSession(db, base, port, { reuse = process.argv.includes("--verify") } = {}) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const file = `${db}.e2e-session.json`;
  let session;
  if (reuse && existsSync(file)) {
    session = JSON.parse(readFileSync(file, "utf8"));
  } else {
    const accounts = await e2eAccounts(db);
    session = await login(base, accounts.buyer);
    session.accounts = Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, { username: a.username, id: a.id, displayName: a.displayName }]));
    writeFileSync(file, JSON.stringify({ ...session, account: { username: accounts.buyer.username, id: accounts.buyer.id } }, null, 1));
    session.passwords = Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, a.password])); // memory only
  }
  if (port) await signInBrowser(port, base, session);
  return session;
}
