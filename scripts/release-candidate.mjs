// Build a LOCAL release-candidate folder from one commit's TRACKED files (4 Nov 2026).
//
//   node scripts/release-candidate.mjs --out <empty-or-new-folder> [--commit <rev>]
//
// - Reads files with `git show <commit>:<path>` only: untracked / ignored files (.env.local, data/, databases,
//   backups, sessions, evidence, node_modules, .next, scratch folders) can never be copied.
// - Leaves out internal hand-over and raw diagnostic output (EXCLUDE below) and writes a short stub in place of the
//   internal status log so that links to it still resolve.
// - In text files, replaces personal identifiers derived at RUN TIME from this machine (home folder, user name,
//   host name, git author name / e-mail) and provider request ids. No personal value is written in this script.
// - Writes <out>/manifest.json (source commit, every file with sha256 and what changed) and <out>/scan.json
//   (remaining-pattern scan: file + type + count, never the matched value). Prints counts only.
// Nothing is pushed, published or uploaded. The source repository is not modified.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const outArg = opt("--out", null);
if (!outArg) {
  console.error("usage: node scripts/release-candidate.mjs --out <folder> [--commit <rev>]");
  process.exit(2);
}
const out = resolve(outArg);
const repo = process.cwd();
const rel = relative(resolve(repo).toLowerCase(), out.toLowerCase());
if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) {
  console.error("REFUSED: --out must be outside the repository.");
  process.exit(2);
}
if (existsSync(out) && readdirSync(out).length) {
  console.error("REFUSED: --out exists and is not empty.");
  process.exit(2);
}

const git = (a, enc = "utf8") => {
  const r = spawnSync("git", a, { cwd: repo, encoding: enc, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const commit = git(["rev-parse", opt("--commit", "HEAD")]).trim();
const commitDate = git(["show", "-s", "--format=%cI", commit]).trim();

/** Left out of the public copy, with the reason recorded in the manifest. */
const EXCLUDE = [
  { re: /^docs\/setup-status\.md$/, reason: "internal status / hand-over log (local paths, provider request ids, session notes); replaced by a stub", stub: true },
  { re: /^docs\/diagnostics\/budget-threads-segfault-logs\//, reason: "raw diagnostic output; the write-up docs/diagnostics/budget-threads-segfault.md stays" },
  { re: /^config\/claude-project-settings\.json$/, reason: "coding-assistant tool configuration, not needed to build or run" },
];

const STUB = `# Status log — not included in this copy

The development status and hand-over log of TradeProof is an internal working document (machine-specific notes,
session hand-overs and account-linked identifiers) and is **not part of the public copy**. Links to it from other
documents are historical pointers.

The public evidence is in:

- \`docs/run-guide.md\` §11 — how this copy was installed, tested and started, and what was not verified;
- \`docs/payment-validation.md\` — PayPal Sandbox evidence (implemented vs MOCK-tested vs real Sandbox);
- \`docs/live-model-acceptance.md\` — real-model extraction of SYNTHETIC quotes (25 Oct 2026);
- \`docs/copilot-cases.md\` §5 — Copilot cases: real run, offline replay and owner review kept apart;
- \`docs/diagnostics/budget-threads-segfault.md\` — an open, rare test-process crash (known issue).

References to files under \`data/\` (local evidence, acceptance ids, local tools) point to Git-ignored local files that
are not published.
`;

// ---- personal identifiers, derived at run time (never printed) ----
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const home = homedir();
const user = userInfo().username;
const host = hostname();
const gitName = spawnSync("git", ["config", "user.name"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const gitEmail = spawnSync("git", ["config", "user.email"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const homeTail = home.replace(/^[A-Za-z]:[\\/]/, ""); // e.g. Users\<name>
const homeVariants = [home, home.replace(/\\/g, "/"), "/" + home[0].toLowerCase() + "/" + homeTail.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")];

/** Ordered replacement rules: [type, regex, replacement]. */
const RULES = [
  ...homeVariants.map((v) => ["local home path", new RegExp(esc(v), "gi"), "<home>"]),
  ...(gitEmail ? [["author e-mail", new RegExp(esc(gitEmail), "gi"), "<author-email>"]] : []),
  ["personal e-mail (gmail)", /[A-Za-z0-9._%+-]+@gmail\.com/gi, "<email>"],
  ...(gitName && gitName.length >= 4 ? [["author name", new RegExp(esc(gitName), "gi"), "<author>"]] : []),
  ...(user && user.length >= 3 ? [["local user name", new RegExp(`\\b${esc(user)}\\b`, "gi"), "<user>"]] : []),
  ...(host && host.length >= 3 ? [["host name", new RegExp(`\\b${esc(host)}\\b`, "gi"), "<host>"]] : []),
  ["provider request id", /req_011[A-Za-z0-9]{6,}/g, "req_…"],
  ["local rules file path", /`…\\Paypal AI Hackathon\\…Official Rules\.docx`/g, "kept outside the repository"],
];

/** Scan-only patterns for what must not remain (reported as file + type + count). */
const SCAN = [
  ...RULES.map(([type, re]) => [type, new RegExp(re.source, re.flags)]),
  ["Windows user folder", /[A-Za-z]:[\\/]+Users[\\/]+(?!<)[A-Za-z0-9._-]+/g],
  ["Git Bash user folder", /\/[a-z]\/Users\/(?!<)[A-Za-z0-9._-]+/g],
  ["AppData / Temp path", /AppData[\\/]+Local[\\/]+Temp/gi],
  ["Anthropic-style key", /sk-ant-[A-Za-z0-9_-]{10,}/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["bearer token", /Bearer\s+A21[A-Za-z0-9_-]{20,}/g],
  ["filled secret assignment", /^(?:PAYPAL_CLIENT_SECRET|AI_API_KEY|ANTHROPIC_API_KEY)=\S+/gm],
  ["e-mail (non-example)", /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/g],
];

const isText = (buf) => !buf.subarray(0, 8000).includes(0);
const files = git(["ls-tree", "-r", "-z", "--name-only", commit]).split("\0").filter(Boolean);
const manifest = { purpose: "local release candidate (not published)", sourceCommit: commit, sourceCommitDate: commitDate, created: new Date().toISOString(), builder: "scripts/release-candidate.mjs", excluded: [], files: [] };
const scan = [];
const totals = {};

mkdirSync(out, { recursive: true });
for (const path of files) {
  const ex = EXCLUDE.find((e) => e.re.test(path));
  if (ex) {
    manifest.excluded.push({ path, reason: ex.reason });
    if (!ex.stub) continue;
  }
  let buf = ex?.stub ? Buffer.from(STUB, "utf8") : git(["show", `${commit}:${path}`], "buffer");
  const changes = {};
  if (!ex?.stub && isText(buf)) {
    let text = buf.toString("utf8");
    for (const [type, re, rep] of RULES) {
      const n = (text.match(re) ?? []).length;
      if (n) {
        changes[type] = (changes[type] ?? 0) + n;
        totals[type] = (totals[type] ?? 0) + n;
        text = text.replace(re, () => rep);
      }
    }
    buf = Buffer.from(text, "utf8");
    for (const [type, re] of SCAN) {
      const n = (text.match(re) ?? []).length;
      if (n) scan.push({ path, type, count: n });
    }
  }
  const dest = join(out, ...path.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  manifest.files.push({ path, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length, ...(ex?.stub ? { stub: true } : {}), ...(Object.keys(changes).length ? { redacted: changes } : {}) });
}

// ---- relative Markdown links in the written copy must resolve (added 9 Nov 2026) ----
const written = new Set(manifest.files.map((f) => f.path));
const brokenLinks = [];
for (const f of manifest.files) {
  if (!f.path.endsWith(".md")) continue;
  const text = git(["show", `${commit}:${f.path}`]).toString();
  const body = f.stub ? STUB : text;
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(?:[a-z]+:|#|<)/i.test(target)) continue; // external, anchor-only or placeholder
    const clean = decodeURI(target.split("#")[0]);
    if (!clean) continue;
    const joined = join(dirname(f.path), clean).replace(/\\/g, "/").replace(/\/$/, "");
    const ok = written.has(joined) || [...written].some((p) => p.startsWith(joined + "/"));
    if (!ok) brokenLinks.push({ path: f.path, target });
  }
}
manifest.linkCheck = { checked: "relative Markdown links [..](..) in written .md files", broken: brokenLinks.length };

const meta = dirname(out);
const base = out.split(/[\\/]/).pop();
writeFileSync(join(meta, `${base}.manifest.json`), JSON.stringify(manifest, null, 1) + "\n");
writeFileSync(join(meta, `${base}.scan.json`), JSON.stringify({ sourceCommit: commit, remaining: scan, brokenLinks }, null, 1) + "\n");
console.log(JSON.stringify({ sourceCommit: commit, filesWritten: manifest.files.length, excluded: manifest.excluded.length, stubs: manifest.files.filter((f) => f.stub).length, redactedFiles: manifest.files.filter((f) => f.redacted).length, redactionsByType: totals, remainingFindings: scan.map(({ path, type, count }) => `${path}: ${type} ×${count}`), brokenLinks: brokenLinks.map(({ path, target }) => `${path} -> ${target}`) }, null, 1));
