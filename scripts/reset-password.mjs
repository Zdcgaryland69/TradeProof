// Local operator step (30 Oct night): change the password of an EXISTING demo account. Run it yourself in a terminal.
//
//   npm run accounts:reset-password            (PowerShell: npm.cmd run accounts:reset-password)
//
// - Asks for the username (shown), then the new password twice with hidden input. Nothing comes from arguments,
//   environment variables or files; the password is never printed, logged or written anywhere except as a scrypt hash.
// - Refuses unknown usernames, passwords shorter than 12 characters, two different entries, and the current password.
// - On success: only the password hash changes, and EVERY session of that account is revoked (reason PASSWORD_RESET),
//   in one transaction, with an audit row. Account id, username, role, display name, ownership, approver grants,
//   approvals and history stay exactly as they are. No account is deleted or re-created.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(join(root, p)).href);

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
          stdin.pause();
          stdin.off("data", onData);
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
  if (!stdin.isTTY) throw new Error("Run this in an interactive terminal (hidden input needs a TTY).");
  const names = store.accounts().map((a) => `${a.username} (${a.displayName}, ${a.role.toLowerCase()})`);
  if (names.length === 0) throw new Error("No accounts exist yet — use npm run accounts:setup.");
  console.log(`Accounts: ${names.join(", ")}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const username = (await rl.question("Username to change: ")).trim().toLowerCase();
  rl.close();
  const account = store.accountByUsername(username);
  if (!account) throw new Error("No such account. Nothing changed.");
  const p1 = await hidden(`New password for ${account.displayName} (min ${MIN_PASSWORD_LENGTH} characters, hidden): `);
  if (p1.length < MIN_PASSWORD_LENGTH) throw new Error("Too short. Nothing changed.");
  const p2 = await hidden("Repeat the new password: ");
  if (p1 !== p2) throw new Error("The two entries differ. Nothing changed.");
  const out = await auth.resetPassword(account.username, p1);
  if (out.status === "SAME_AS_CURRENT") throw new Error("That is the current password. Nothing changed.");
  if (out.status !== "RESET") throw new Error(`Refused (${out.status}). Nothing changed.`);
  console.log(`${account.displayName}: password changed. Sessions revoked: ${out.revokedSessions}. Id, role, ownership and history unchanged.`);
} catch (err) {
  console.error(`Stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
