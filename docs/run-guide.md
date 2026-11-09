# TradeProof — run guide (local, reproducible)

> Written and verified **3 Nov 2026 (SGT)** from a **fresh `git clone` of the local repository** into an empty temporary
> folder — no copied database, no `.env.local`, no accounts, sessions or keys. Verified with **Node.js 24.19.0 / npm
> 11.17.0 on Windows 11** (Git Bash and Windows PowerShell 5.1). The project requires Node.js **22.18 or newer**
> (`package.json` engines); other Node versions and macOS / Linux were **not** tested. What was run, and what was not,
> is listed in §11.

Commands are given twice: **Windows PowerShell** (`npm.cmd`, `$env:NAME = "value"`) and **Git Bash** (`npm`,
`NAME=value command`). Do not mix the two syntaxes in one terminal.

## 1. What TradeProof is

A local web app (Next.js 16, TypeScript, SQLite via the built-in `node:sqlite`) that carries one cross-border purchase
from request to PayPal **Sandbox** payment: quotes pasted as text and kept as immutable versions, extraction with
source excerpts checked against the quote text (unstated values stay unknown), buyer review, deterministic comparison, bilingual clarification drafts, supplier reply
tracking, an approval bound to one quote version, and payment of exactly the approved amount to one fixed Sandbox test
merchant. An English AI Copilot explains TradeProof's own facts (five buttons). Target user (hypothesis): a small
business buying samples or small batches from a small overseas supplier. Not built: PDF / Excel import, escrow, paying
arbitrary suppliers, deposits, Live PayPal. See `README.md` and `docs/product-brief.md`.

## 2. Install

Prerequisites: Node.js ≥ 22.18 (LTS recommended), Git, a modern browser. No global packages.

PowerShell:

```powershell
git clone <repository-url> TradeProof
cd TradeProof
node --version          # must be v22.18.0 or newer
npm.cmd ci              # installs exactly the versions in package-lock.json
```

Git Bash:

```bash
git clone <repository-url> TradeProof
cd TradeProof
node --version
npm ci
```

`npm ci` took about 20 s on the verification machine (384 packages). npm 11 prints a warning that the install script
of `unrs-resolver` (a lint dependency) was not run because it is not in an allow-list; lint and type-check still passed
without it. Nothing else needs to be installed for the MOCK demo. **No `.env.local` is needed.**

## 3. Safe MOCK start

All `mock:*` commands go through `scripts/local-mock.mjs`. It:

- uses a **separate database**: `data/mock/tradeproof-mock.sqlite` by default, or the file named by
  `TRADEPROOF_MOCK_DB`; the folder `data/` is Git-ignored and the file is created on first use;
- forces **MOCK extraction** (canned SYNTHETIC output of the three built-in demo quotes), **MOCK Copilot answers**,
  **MOCK PayPal** (a local JSON file next to the database, no network) and blanks every key, so values in `.env.local`
  are never used;
- runs the app's own configuration resolvers first and **refuses to start** (exit code 2) if the main database, a real
  model, the Copilot live switch or real payments would be active — there is no silent fallback;
- refuses `TRADEPROOF_MOCK_DB` pointing at the main database, and refuses when `TRADEPROOF_DB_PATH` is set in the
  terminal to another file.

| Command (Git Bash: `npm run …`; PowerShell: `npm.cmd run …`) | What it does |
| --- | --- |
| `mock:check` | prints the resolved mode (database, extraction, Copilot, payments) — states only, never values |
| `mock:accounts` | creates `buyer-a`, `buyer-b`, `approver` in the MOCK database (hidden input, twice, ≥ 12 characters) |
| `mock:reset-password` | changes the password of an existing account in the MOCK database (hidden input) |
| `mock:seed-base` | base material for a demo: the SYNTHETIC request, quote version 1 and one MOCK extraction run — **nothing reviewed** |
| `mock:seed` | **rehearsal only**: one record prepared up to "approver assigned"; the script writes the reviews (not a person's review) |
| `mock:start` | starts `http://127.0.0.1:3000` (loopback only) in MOCK mode |
| `mock:close` | after the server has stopped: checkpoints and closes the MOCK database |

Use another MOCK file — PowerShell:

```powershell
$env:TRADEPROOF_MOCK_DB = "data\mock\my-demo.sqlite"
npm.cmd run mock:start
Remove-Item Env:TRADEPROOF_MOCK_DB      # when done
```

Git Bash:

```bash
TRADEPROOF_MOCK_DB=data/mock/my-demo.sqlite npm run mock:start
```

The first page load compiles for a few seconds (cold compile ≈ 1 s per page on the verification machine; warm ≈ 0.15–0.25 s).

## 4. Accounts and roles

Run `mock:accounts` in an **interactive terminal** (the passwords are typed with hidden input; they never come from
arguments, environment variables or files and are stored only as scrypt hashes). An existing account is skipped, never
overwritten.

| Account | Role | Can |
| --- | --- | --- |
| `buyer-a`, `buyer-b` | Buyer | create requests (each buyer sees only their own), paste quotes, run extraction, review values, compare, draft clarifications, record replies, assign / remove an approver, start the payment of an Active approval |
| `approver` | Approver | open only requests a buyer assigned to them, review the approval preview, approve or revoke; cannot create requests, cannot pay |

There is no registration and no e-mail reset; `mock:reset-password` changes a password locally and signs that account
out everywhere. Sign-in sessions are stored in the same database.

## 5. Demo data

- **Built-in SYNTHETIC samples** (`samples/synthetic/`): on **+ New request** press **Load demo (SYNTHETIC)**; on a
  request's **Add a quote** page, **Load demo** offers the Chinese quote, the English quote and the revised sample-order
  quote. MOCK extraction only has output for these three texts; any other text fails honestly (`MOCK_NO_FIXTURE`).
- **Full flow by hand:** `docs/demo-script.md` (20 steps, buyer and approver, ends with a MOCK payment of USD 68.00).
- **Base material for a recording:** `mock:seed-base` (request, quote v1, MOCK run; every review left to the presenter).
- **Rehearsal record:** `mock:seed` — reviews, answers and classifications are written by the script as the buyer.
  Use it to check the flow and timing only, never for a recorded demo.

All demo data is fictional and marked SYNTHETIC / DEMO.

## 6. Tests

**Unit tests** — no server, no network, no keys (MOCK PayPal gateway, MOCK / fake models, temporary databases):

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

```bash
npm run typecheck && npm run lint && npm test
```

Result on the clean clone (3 Nov 2026): type-check pass, lint pass, **492 / 492** tests pass (≈ 23 s of test time).
Two known intermittent issues are **open** (not fixed by this guide): a rare `EPERM` when a test removes its temporary
folder (likely cause fixed, proven by one clean run only), and a rare crash (exit 139) in the multi-thread budget test
(`docs/diagnostics/budget-threads-segfault.md`). If one appears, re-run the named file to check its tests
(this does not fix the issue): `node --test tests/<file>.test.ts`.

**Browser checks** (`scripts/e2e/*.e2e.mjs`, manual, not part of `npm test`):

- need **Microsoft Edge** at the default Windows path, or `EDGE_PATH` set to another Chromium-based browser executable;
  `HEADLESS=1` runs it headless;
- work **only on a database copy**: the script gets `E2E_DB=<copy>` and the dev server must run on the **same** file;
  each run creates its own throwaway accounts with random passwords held in memory only;
- each script's header names the server mode it needs (for example `approval-payment.e2e.mjs` needs MOCK payments,
  which `mock:start` provides; `copilot.e2e.mjs` and `usability.e2e.mjs` need the payment switch off);
- they add [TEST] records to the copy — use a dedicated copy, e.g. copy your MOCK file to `data/mock/e2e.sqlite` and
  start the server with `TRADEPROOF_MOCK_DB=data/mock/e2e.sqlite`.

Browser checks were **not** re-run on the 3 Nov clean clone; a sign-in / isolation / Copilot smoke check and the MOCK payment check ran on the 4 Nov release-candidate copy (§11).

## 7. Stopping and data

1. In the server terminal press **Ctrl+C** (PowerShell may ask "Terminate batch job (Y/N)?" — answer `Y`).
2. Run `mock:close`. It refuses while port 3000 is still in use, then checkpoints the database (folds the `-wal` file
   into the main file) and runs an integrity check.
3. Data stays in the MOCK file under `data/mock/` (Git-ignored). Deleting that file (and its `-wal`, `-shm` and
   `.mock-paypal.json` neighbours) resets the MOCK demo; nothing else is touched.

If the terminal was closed without Ctrl+C, a `node` process may still hold port 3000: check with
`Get-NetTCPConnection -LocalPort 3000` (PowerShell) and stop only the process whose command line contains your
TradeProof folder. SQLite data written before a crash is kept (write-ahead log); run `mock:close` afterwards.

## 8. Known limits and troubleshooting

| Symptom / question | Answer |
| --- | --- |
| `REFUSED: … TRADEPROOF_DB_PATH is set …` | remove it (`Remove-Item Env:TRADEPROOF_DB_PATH` / `unset TRADEPROOF_DB_PATH`) or use `TRADEPROOF_MOCK_DB` |
| `REFUSED: port 3000 is already in use` | another server is running; stop it first (see §7) |
| PowerShell: "running scripts is disabled" for `npm` | use `npm.cmd` |
| Page reloads in a loop after switching database | `mock:start` clears `.next` when the database changes; if it still happens, stop the server, delete `.next`, start again |
| "MOCK has no canned output for this text" | MOCK extraction reads only the three built-in demo quotes |
| Another buyer's request shows a not-found page (HTTP 200 in dev) | expected: requests are private to their owner; the API answers 404 |
| A confirmed value can be confirmed again | each click appends a review row; after an approval that invalidates it (fail-safe, deferred) |
| Quotes from PDF / Excel | not supported; paste the quote text |
| Deposits / staged payments | blocked by design; v1 pays one full USD amount once |
| Language | Copilot answers in English only; clarification drafts are EN / 简体中文 |
| Payee | always the one Sandbox test merchant from the configuration (MOCK: a fixed MOCK payee) — never a supplier's account; not escrow |
| Production / online | the supported way to run TradeProof is the **local dev server** (`mock:start` or `npm run dev`). `npm run build` succeeds, but `npm start` (production serving) **deliberately** answers only the landing page: `/login`, every procurement page and every API answer 404 (`src/proxy.ts` refuses production and non-loopback hosts by design). There is no hosted deployment (see `docs/release-plan.md`) |

## 9. Real services (optional, not needed for the demo)

`npm run dev` (PowerShell `npm.cmd run dev`) uses the **main database** `data/sandbox-payments.sqlite` and reads
`.env.local`. Copy `.env.example` to `.env.local` and fill in your own values only if you intend real calls:

- **Real model extraction** needs `AI_PROVIDER=anthropic`, `AI_MODEL`, `AI_API_KEY` and every `AI_BUDGET_*` /
  `AI_PRICE_*` value; every call is reserved and settled in a local budget ledger and refused when a limit is reached.
- **Real Copilot explanations** additionally need `TRADEPROOF_COPILOT_LIVE=on`.
- **PayPal Sandbox payments** need the three `PAYPAL_*` values and `TRADEPROOF_APPROVAL_PAYMENTS=sandbox`, and run only
  on the main database. Without the switch every payment step answers `409 PAYMENTS_NOT_ENABLED`.

To run the main database without any real call while `.env.local` is filled, blank the values for that terminal —
PowerShell: `$env:AI_PROVIDER = " "; npm.cmd run dev`; Git Bash: `AI_PROVIDER=" " npm run dev` (payments stay off
unless the switch is set). Check first with
`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-config-check.mts`, which prints only states.
A schema upgrade migrates the main database on first open, after writing a backup to `data/backups/`.

## 10. Environment variables

See `.env.example` (names, purpose, safe defaults; every key empty). MOCK mode needs none of them.

## 11. Verification record (3 Nov 2026, SGT)

| Step | Command | Result |
| --- | --- | --- |
| Clean clone | `git clone` of the local repository into an empty temporary folder | no `data/`, no `.env.local` |
| Install | `npm ci` (Git Bash) | 384 packages, exit 0, ≈ 21 s (npm's local download cache may have been used) |
| Mode check | `npm run mock:check` (Git Bash) and `npm.cmd run mock:check` (PowerShell) | MOCK database, `READY MOCK`, Copilot live off, payments MOCK |
| Refusals | `TRADEPROOF_MOCK_DB=data/sandbox-payments.sqlite`; `TRADEPROOF_DB_PATH` set to another file (both shells) | refused, exit 2 |
| Hostile `.env.local` | a temporary `.env.local` with placeholder LIVE values (`AI_PROVIDER=anthropic`, Copilot on, payments sandbox, DB path = main file; no real keys) | `mock:check` still MOCK on the MOCK file; the same file with plain `next dev` would resolve LIVE / SANDBOX / main DB — removed afterwards |
| Empty database + accounts | `mock:accounts` | database created at schema v18; three accounts created. Hidden input was fed by a test harness that simulates a terminal (temporary random passwords, never printed); **typing by a person was not exercised** |
| Base seed | `mock:seed-base` | request + quote v1 + 1 MOCK run, 0 reviews |
| Server | `mock:start`, then sign-in over HTTP | landing 200; signed-out → `/login`; wrong password 401; buyer-a list / request / quotes pages 200 with MOCK label; buyer-b and an unassigned approver get API 404 and no record data |
| Stop + close | process stop, `mock:close` | port free; checkpoint ok, quick_check ok; ledger 0 rows, payment records 0 |
| Tests | `npm run typecheck`, `npm run lint`, `npm test` | pass, pass, 492 / 492 |
| Not run on the clone | `npm run build`, browser checks, Ctrl+C in an interactive terminal, the full 20-step flow by a person | — (build and browser checks: see 4 Nov below) |

**4 Nov 2026 (SGT) — release-candidate copy.** A folder made by `scripts/release-candidate.mjs` from commit `658753d`
(tracked files only; internal status log replaced by a stub, raw diagnostic logs and tool config left out), copied to a
separate empty folder — no database, no `.env.local`, no `.git`:

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | exit 0 (≈ 70 s; npm's local cache may have been used); same `unrs-resolver` notice |
| Mode | `npm run mock:check` | MOCK database (not created yet), `READY MOCK`, Copilot live off, payments MOCK, no `.env` file |
| Accounts | `mock:accounts`, `mock:reset-password` | the real scripts; hidden input fed by a test harness that simulates a terminal (temporary random passwords, never printed). **A person typing was not exercised** |
| Base seed | `mock:seed-base` | request + quote v1 + 1 MOCK run, 0 reviews |
| Lint / types | `npm run lint`, `npm run typecheck` | pass, pass (server stopped) |
| Build | `npm run build` (server stopped) | **pass** (≈ 15 s); no database file created |
| Production serving | `next start -H 127.0.0.1` | landing page 200; `/login`, `/procurements`, `/api/procurements`, `/api/auth/session`, `/sandbox-demo` **404** — by design, not changed |
| Port guard | `mock:start` while another server held port 3000 | refused, exit 2 |
| Dev start | `mock:start` | cleared the build's `.next`; ready on 127.0.0.1:3000 |
| Browser | Edge headless, sign-in through the login **form** with the three accounts | 17 / 17: signed-out redirect and API 401; wrong password stays on `/login`; buyer-a list, request, quotes page with MOCK run, Copilot panel (MOCK, five buttons, no text input) and a MOCK answer; sign-out; buyer-b and the unassigned approver do not see the request (API 404, not-found page, not listed); no request to any other host; no page exception. First run 15 / 17 — two checks of my script read the page before it had loaded (fixed in the script, not in the app) |
| Payment (MOCK) | approve + MOCK payment on a copy of the rehearsal database; `approval-payment.e2e` | PAID (MOCK) USD 68.00; 11 / 11 after the display fix below |
| Stop | processes stopped by command line (no interactive Ctrl+C was possible here), then `mock:close` | all project processes gone, port 3000 free, checkpoint + quick_check ok; ledger 0, payment records 0 |
| Not run | `npm test` on the copy (no tested code differs from the 492 / 492 run of 3 Nov), Ctrl+C typed in a terminal, macOS / Linux | — |

Defect found and fixed (`9b7f25c`, display only): the approval page's payment facts squeezed into a narrow column once
a payment record existed.

**9 Nov 2026 (SGT) — final release candidate.** Folder made by `scripts/release-candidate.mjs` from commit `aeb9898`
(MIT `LICENSE`, rewritten README, credits, submission drafts; app code identical to the frozen `097a11a` line plus the
display / wording fixes up to `13cc37a`). Builder scan: 0 remaining findings, 0 broken relative links; a separate scan
found none of the configured secret values and no real PayPal / payee identifier (only fake test ids). Copied to a
separate empty folder — no database, no `.env.local`, no `.git`, no `node_modules`:

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | exit 0 (≈ 104 s); same `unrs-resolver` install-script notice |
| Audit | `npm audit --omit=dev` | **1 high-severity advisory**: `follow-redirects` 1.16.1 (GHSA-mrwp-f3q8-3g9p), pulled in by `@paypal/paypal-server-sdk` → `axios`; not updated (dependency change after the freeze is an owner decision) |
| Lint / types | `npm run lint`, `npm run typecheck` | pass, pass |
| Build | `npm run build` (no server running) | pass; no database file created |
| Unit tests | `npm test` | **517 / 517** pass (one run; no `EPERM`, no exit 139 in this run — both stay open, see §6) |
| Mode | `mock:check` | `READY MOCK`, MOCK database, payments MOCK |
| Accounts | `mock:accounts` (the real script) | three accounts created; hidden input typed by a harness that simulates a terminal (random passwords in memory only, never printed). **A person typing was not exercised** |
| Demo data | `mock:seed-base`, then `mock:seed` (rehearsal record; reviews written by the script, not a person) | two records, the second with the approver assigned |
| Browser smoke | `mock:start`; Edge headless; every sign-in through the **login form** (session + CSRF set by the app) | **29 / 29** incl. setup steps: signed-out redirect and API 401; wrong password stays on `/login`; buyer-a sees both records and the MOCK run; Copilot five buttons, no text input, MOCK answer with 13 cited facts; buyer-b and the unassigned approver get API 404 / not listed; approver ticks the one confirmation (Approve disabled before) → Approved — Active; buyer-a pays through the approval page → **PAID (MOCK) USD 68.00**, one record `TP-APPROVAL-MOCK`; no request to another host; no page exception; AI budget ledger 0 rows |
| First attempt | same | 26 / 27 checks, then my check script crashed after the last check (missing helper) — server and browser ended with it, `mock:close` run by hand. Failed check = my script read the Copilot mode attribute before the panel's first answer set it (script fault, app unchanged). Script fixed; database files of the copy deleted by name; full sequence re-run → 29 / 29 |
| Production serving | `npm run build` again, `next start` on port 3001 | `/` 200; `/login`, `/procurements`, `/api/procurements`, `/api/auth/session`, `/sandbox-demo` **404** — by design |
| Stop | server process tree stopped by PID (no interactive Ctrl+C possible here), then `mock:close` | port free; checkpoint + quick_check ok |
| Not run | macOS / Linux; a person typing passwords; Ctrl+C in a terminal; the full 20-step demo by hand; the other `scripts/e2e` scripts | — |

**9 Nov 2026 (SGT, later) — candidate after the dependency fix.** Folder from commit `1c75e7b` (adds the
`follow-redirects` 1.16.2 override from `91834f6`, the advisory analysis `docs/security/follow-redirects-2026-11-09.md`
and wording alignment in README / credits / submission drafts; app code unchanged). Builder scan 0 findings, 0 broken
links. Separate empty folder, no database, no `.env.local`, no `.git`, no `node_modules`:

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | exit 0 (≈ 31 s); `npm ls follow-redirects` → `1.16.2 overridden` |
| Audit | `npm audit --omit=dev`; `npm audit` | **0 vulnerabilities** in production dependencies; 8 moderate in development-only packages (the `minimatch` advisory in the ESLint toolchain; unchanged, not applied — npm's fix is a breaking downgrade) |
| Lint / types / build | `npm run lint`, `npm run typecheck`, `npm run build` | pass, pass, pass |
| Unit tests | `npm test` | **517 / 517** (one run; no `EPERM`, no exit 139 in this run) |
| README MOCK steps + browser smoke | same procedure as above | **29 / 29** on the first attempt |
| MOCK payment regression | `scripts/e2e/approval-payment.e2e.mjs` on a separate copy, then `--verify` after a server restart | **11 / 11**, then **5 / 5** (double-click start / capture → one record and one capture; approval invalid after an edit to its basis → capture refused 409; unknown capture never re-sent; no request to another host) |
| First attempt of that regression | same | 0 / 1 and 0 / 3: my setup copied the database **without** its simulated-PayPal state file, so the fresh MOCK gateway re-issued order id `…0001` that already existed → `UNIQUE constraint failed` (HTTP 500 on create order). Setup fault, not an app or dependency change; copy files deleted by name, setup fixed (state file copied with its database), re-run as above |
| Redirect behaviour of the installed dependencies | loopback-only test (`127.0.0.1` → 302 → `localhost`) | 1.16.2 strips a custom credential listed in a cross-realm `sensitiveHeaders` array (1.16.1 forwards it); `Authorization` stripped in every case |
| Production serving | `npm run build`, `next start` on port 3001 | `/` 200; `/login`, `/procurements`, `/api/procurements`, `/api/auth/session`, `/sandbox-demo` 404 — by design |
| Not run | real PayPal Sandbox requests (not authorised; would be the only path that uses `follow-redirects`); macOS / Linux; a person typing; other `scripts/e2e` scripts | — |
