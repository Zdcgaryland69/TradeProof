// Local operator step (30 Oct): creates the three preset demo accounts — buyer-a "Buyer A", buyer-b "Buyer B",
// approver "Approver" — in the app database. Run it yourself in a terminal; each password is typed with hidden input,
// twice. Passwords never come from arguments, environment variables or files, and are stored only as scrypt hashes.
//
//   npm run accounts:setup
//
// - An account that already exists is SKIPPED, never overwritten (to change a password: npm run accounts:reset-password).
// - An empty or short (< 12 characters) password, or two different entries, creates nothing for that account.
// - Stop the dev server first only if this is the first run after an upgrade (the database is migrated on open, with
//   a backup); otherwise it can run while the server is up.

import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(join(root, p)).href);

const ACCOUNTS = [
  { username: "buyer-a", role: "BUYER", displayName: "Buyer A" },
  { username: "buyer-b", role: "BUYER", displayName: "Buyer B" },
  { username: "approver", role: "APPROVER", displayName: "Approver" },
];

/** Reads one line without echoing it (raw mode). Ctrl+C aborts. */
function hidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) return reject(new Error("Run this in an interactive terminal (hidden input needs a TTY)."));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          return reject(new Error("aborted"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const [{ AuthStore }, { AuthService }, { MIN_PASSWORD_LENGTH }, { APP_DB_PATH }] = await Promise.all([
  load("src/server/auth/store.ts"),
  load("src/server/auth/service.ts"),
  load("src/server/auth/password.ts"),
  load("src/server/db/location.ts"),
]);
const store = new AuthStore(APP_DB_PATH, { onBackup: (f) => console.log(`backup written before migration: ${f}`) });
const auth = new AuthService(store);
try {
  for (const a of ACCOUNTS) {
    if (store.accountByUsername(a.username)) {
      console.log(`${a.displayName} (${a.username}): exists — skipped, not changed.`);
      continue;
    }
    const p1 = await hidden(`${a.displayName} (${a.username}) — new password (min ${MIN_PASSWORD_LENGTH} characters, hidden): `);
    if (p1.length < MIN_PASSWORD_LENGTH) {
      console.log(`  too short — ${a.displayName} NOT created.`);
      continue;
    }
    const p2 = await hidden(`${a.displayName} (${a.username}) — repeat password: `);
    if (p1 !== p2) {
      console.log(`  entries differ — ${a.displayName} NOT created.`);
      continue;
    }
    const out = await auth.createAccount(a.username, a.role, a.displayName, p1);
    console.log(`  ${a.displayName}: ${out === "CREATED" ? "created" : "exists — skipped"}.`);
  }
} catch (err) {
  console.error(`Stopped: ${err.message} Nothing more was created.`);
  process.exitCode = 1;
} finally {
  store.close();
}
