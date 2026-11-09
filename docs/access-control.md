# Sign-in and object-level access control — implementation note (30 Oct 2026)

Owner decisions (30 Oct, confirmed; not re-opened here): three preset demo accounts **Buyer A**, **Buyer B**, **Approver**; username + password; server-side sessions; no registration, password reset, supplier portal or third-party login. Earlier design: `docs/design-24oct-additions.md` §6.4 (this note supersedes its open points). Ownership candidates: `docs/access-ownership-candidates.md` (nothing is assigned in this phase).

## 1. Minimal data (migration = the next free schema number when executed: **v15**)

| Table | Rows | Mutability |
| --- | --- | --- |
| `principals` | id `u_…`, username (unique, lower-case), role `BUYER` / `APPROVER`, display name, **scrypt password hash** (salt + parameters in the string), created at | immutable (UPDATE / DELETE refused by triggers): no reset, no silent overwrite |
| `sessions` | id, principal, **SHA-256 of the session token**, SHA-256 of the CSRF token, created / last seen / expires, revoked at + reason | only `last_seen_at` and the revocation columns change; never deleted |
| `procurement_owners` | request → buyer, how (`CREATED_BY_BUYER` / `OPERATOR_SEED`), when | immutable (no ownership transfer) |
| `approver_grants` | request, approver, `GRANT` / `REVOKE`, acting buyer, time | append-only; current state = latest row per (request, approver) |
| `access_audit` | time, actor id + role (or none), action, object type + id, outcome, small JSON detail | append-only; never passwords, tokens, keys or quote / reply text |

No existing table is changed, nothing is back-filled: **existing records get no owner and are invisible to the three accounts**; historical approvals keep `LOCAL_DEV` (not signed in).

## 2. Authentication and sessions

- **Passwords:** Node's built-in `crypto.scrypt` (N = 2^15, r = 8, p = 1, 16-byte salt, 32-byte key), constant-time compare. Minimum length 12. Never in code, docs, seeds, screenshots or Git.
- **Accounts are created only by a local operator script** (`npm run accounts:setup`) that reads each password with hidden input twice. An existing account is skipped, never overwritten; an empty password creates nothing. There is no default password.
- **Session token:** 32 random bytes (base64url); only its SHA-256 is stored. Lifetime 8 h absolute, 60 min idle; revocable on the server.
- **Cookies:** `tp_session` = HttpOnly, SameSite=Strict, Path=/; `Secure` when the request is HTTPS or the app runs in production. On local `http://127.0.0.1` the cookie **cannot** be Secure (browsers would drop it) — a stated limit of the local demo. `tp_csrf` (readable by the page, SameSite=Strict, Path=/) carries the CSRF token.
- **Login** creates a fresh session (and revokes a session cookie the browser already presented — no fixation). **Logout** revokes the session on the server; the old cookie stops working at once.
- **CSRF:** every non-GET API request needs header `X-TradeProof-CSRF` equal to the session's token (compared by hash, constant time) **and** the existing same-origin `Origin` check. The Host check is the local-only guard, not authentication or CSRF protection.
- **Failed logins:** one message for unknown user and wrong password; the same scrypt work is done for unknown users; after 5 failures for a username within 15 min, further attempts for it are refused for 15 min (also for unknown usernames). Counted from the audit table (attempted usernames stored only as a hash). Demo-level, not production-grade (no IP reputation, no MFA).
- No token in `localStorage`; client code reads only the CSRF cookie.

## 3. Policy (`src/server/access/policy.ts`)

`Principal` = signed-in `BUYER` or `APPROVER` (id, username, role, session) with a server-side lookup. **`LOCAL_DEV` is no longer a principal**: no route or page creates one; it survives only as the recorded actor of historical approvals. No session → 401 (API) / redirect to `/login` (pages).

| Action | Buyer (owner) | Buyer (not owner) | Approver assigned | Approver not assigned | Signed out |
| --- | --- | --- | --- | --- | --- |
| List / search / count | own requests only | — | assigned requests only | — | 401 |
| Read request, history, quotes, versions, raw text, snapshots, supplier numbers, runs, reviews, comparison, drafts, replies, answers, links, approval preview / history, payment status | ✓ | 404 | ✓ | 404 | 401 |
| Create request | ✓ (becomes owner) | — | ✗ (403) | ✗ | 401 |
| Edit request, save quote / version, run extraction, review, classify requirement, drafts, replies, answers, links | ✓ | 404 | **✗ 404** | 404 | 401 |
| Assign / revoke approver | ✓ | 404 | ✗ 404 | 404 | 401 |
| Approve | **✗** (no self-approval) | 404 | ✓ (grant re-checked inside the write transaction) | 404 | 401 |
| Revoke approval | ✓ (stops further payment; not a refund) | 404 | ✓ | 404 | 401 |
| Payment record / order / capture / reconcile | ✓ (switch permitting) | 404 | **✗ 404** | 404 | 401 |
| Old `/sandbox-demo` page + APIs | 404 (disabled) | 404 | 404 | 404 | 404 |

"Not allowed" and "does not exist" give the **same 404** body. Lists and search apply the scope **in SQL before** matching, counting, sorting and LIMIT. Every child id (series, version, run, review, draft, reply, link, approval, payment) is resolved **through** the request id it is addressed with; a child of another request is 404. Responses carry `Cache-Control: no-store`; pages are rendered per request.

**Budget:** the ledger stays global and server-side. Pages show only whether a live run is currently possible (yes / no + a short reason); totals, other users' rows and configuration stay hidden.

**Future Copilot:** `readRecordFor(principal, requestId)` (`src/server/access/record-context.ts`) is the one entry that returns a record's data for the current user, or null. Not used by any model call in this phase.

## 4. Approval and payment

- The actor comes from the session (`actorOf`), never from the client. New approvals record `APPROVER`, account id, authenticated.
- **Approve:** only a currently assigned approver; the grant is re-read inside the `BEGIN IMMEDIATE` approve transaction.
- **Revoking an approver's grant** (owner): the next request of that approver is refused; every not-yet-paid approval that approver made on the request becomes invalid (`APPROVER_UNASSIGNED`, from the append-only grant row after the approval — re-granting later does **not** restore it; a new approval is needed). Audited. *(31 Oct correction: "after the approval" was decided by `created_at` timestamps until v17; since v17 by grant sequence — §12.)*
- **Payment** (record, order, capture): re-checks inside the payment transaction — caller owns the request, approval valid, approval made by an authenticated approver whose grant has not been revoked since, no other payment paid / open. *(31 Oct correction: until v17 "not revoked since" was a timestamp comparison only and the current assignment was not read; since v17 the assignment is read by grant sequence inside these transactions — §12.)* **Historical `LOCAL_DEV` approvals are never payable** (`LEGACY_UNAUTHENTICATED_APPROVAL`); their rows, snapshots and events stay as they are.
- Unchanged boundaries: check + claim in one short transaction, PayPal after commit, sent requests cannot be undone, unknown outcomes only read. Switch stays off this phase; role tests use temp DBs and MOCK PayPal.
- **Historical data:** the two real Sandbox payments (USD 1.00, USD 12.00) stay PAID, are not queried, rebuilt or re-captured. Their records are visible to nobody until the owner decides about old records.

## 5. Migration and restore

1. Stop the dev server; normal WAL checkpoint.
2. Consistent backup (`VACUUM INTO`) of the v14 file.
3. Rehearse on a copy: migrate, compare every existing table's rows (hash) and triggers, integrity, FK; then **restore drill**: copy the backup back over a scratch file and check it opens as v14 with identical hashes.
4. Apply to the real file (the runner writes its own backup first); compare again.
5. **Restore** = stop the server, copy the v14 backup over `data/sandbox-payments.sqlite` (with WAL / SHM absent after a normal close), start the v14 code (`git checkout cf44012`). The v15 code refuses nothing in a v14 file — it migrates it again.

## 6. Turning off the old local-developer mode

`LOCAL_DEV_PRINCIPAL` is removed; pages call `requireSignedIn()`; every API handler goes through `guard()` (loopback Host + Origin + session + CSRF). `/sandbox-demo` and its APIs return 404. Test and seed scripts no longer get anonymous access: unit tests pass explicit test principals to services (test-double lookups live only under `tests/`), HTTP tests log in through the real session code, and the browser check signs in with test accounts it creates in a database **copy**. The older per-feature browser scripts (`scripts/e2e/*.e2e.mjs` before 30 Oct) still assume anonymous access and are not updated in this phase.

## 7. Acceptance

Automated: matrix rows AC1–AC14 in `docs/design-24oct-additions.md` §8. Owner: five steps in `docs/setup-status.md` (30 Oct), after the owner sets the three passwords with `npm run accounts:setup` and seeds the demo records with `npm run accounts:seed-demo`.

## 8. As built (30 Oct 2026 evening, SGT) and evidence

**Built:** schema v15 (5 tables, 11 triggers); `src/server/auth/` (password, store, service, gate, http, index); `policy.ts` without `LOCAL_DEV`; every API handler through `guard()`; every page through `requireSignedInPage()` + `canReadRequest`; owner set in the create transaction; scoped list; `/login`, sign-out bar, Access panel (assign / remove approver), read-only views for approvers; budget shown as availability only; legacy approvals not payable; `/sandbox-demo` off; `readRecordFor()` for the future Copilot; `npm run accounts:setup` (hidden input) and `npm run accounts:seed-demo`; `src/proxy.ts` sends requests **without any session cookie** to `/login` (307) / 401 before rendering.

**Found and fixed by the new tests:** audit rows were written through the auth store's connection *inside* the approval store's write transaction (approve, revoke, payment refusal) → "database is locked" after 5 s. Audit rows are now written right after COMMIT.

**Evidence (kept apart):**

| Kind | Result |
| --- | --- |
| Automated | `npm test` **402/402** in one run (392 + 10 in `tests/access.test.ts`); access tests 10/10 after fixes (first runs: 4/10 → 8/10 → 9/10; failures were the lock bug above and three wrong test expectations, listed in setup-status). Mutation check: removing the detail read check, the in-transaction grant re-check or the list scope each makes access tests fail (restored). lint / typecheck pass; `npm run build` pass (dev server stopped; `.next` cleared) |
| Browser, automated (`npm run e2e:access`, DB **copy**, four separate Edge processes and profiles, test accounts with per-run random passwords in memory only) | **21/21** first run: signed out → /login and API 401; lists A only / B only / approver none; B → A's URL and API 404, search empty; approver unassigned 404; A assigns; buyer has no Approve; approver read-only, approves, recorded "Approver (approver, signed in)", no payment controls, API edit 404; A removes approver → approver 404, approval "No longer valid"; cookie HttpOnly + SameSite=Strict (not Secure on local http); after sign-out the old cookie put back → /login; no other host; no console errors. Run **before** the proxy early-exit was added; the proxy change was checked with HTTP probes only (307 / 401 / 404 as expected) |
| Owner | not yet (five steps in setup-status) |

**Limits (honest):**
- A page request with a *present but invalid* session cookie still gets HTTP 200 carrying only the redirect to `/login` (the loading boundary has started the stream); no record data is in it (checked). APIs answer 401.
- Login throttling is per name in the audit table (demo level): no IP limits, no MFA, no password rules beyond length 12.
- Local `http://127.0.0.1` cookies cannot be `Secure`; HTTPS / production would set it.
- Existing feature tests use test-only principals (`tests/helpers/principals.ts`) that own / are assigned to everything in their temp DB; access itself is tested with the real lookup, sessions and cookies.
- **Not updated:** the older browser scripts (`approval`, `approval-payment`, `clarification`, `comparison`, `edit-conflict`, `extraction`, `history`, `quotes`, `replies`, `search-budget`) still assume anonymous access and now stop at `/login` / 401. They need a sign-in step before they can be used again.
- Thread-test segfault: did not occur in this run; still open.

## 9. Local password reset (30 Oct 2026 night, schema v16)

Reason: the owner reported that the three demo passwords had been exposed in a chat; they must be replaced.

- **Before:** no reset existed (`principals` was fully immutable; `accounts:setup` only creates missing accounts).
- **Added:** `npm run accounts:reset-password` (PowerShell: `npm.cmd run accounts:reset-password`), local operator only, own terminal. Username shown; new password typed twice with hidden input; refuses unknown names, < 12 characters, different entries and the current password. Nothing from arguments, environment or files; nothing printed or logged except "password changed, sessions revoked: N".
- **Effect, one transaction:** only `password_hash` changes (new scrypt hash); **every** session of that account is revoked (`PASSWORD_RESET`); one audit row (`PASSWORD_RESET`, account id, number of sessions, no password or hash). Id, username, role, display name, creation time, ownership, approver grants, approvals and history are untouched; no account is deleted or re-created; other accounts' sessions stay.
- **Schema v16** (next free number): `principals_immutable` replaced by `principals_fixed_columns` (everything except `password_hash` stays immutable; no delete); `sessions` rebuilt with every row copied to allow the reason `PASSWORD_RESET`. Backup, rehearsal on a copy (27 tables row-identical, only the intended trigger change, integrity ok, FK 0), restore drill (back to v15, identical), then the real DB with the same result.
- **Tests:** `tests/access.test.ts` +2 (reset rules and effects; migration v15 → v16 on a copy); `npm test` 404/404; lint / typecheck pass. The script's interactive path needs a terminal and was not run by me; its no-terminal path refuses and changes nothing (checked on a copy). Build not re-run (no page changed).

## 10. Owner check, signed-in browser checks, atomic approval audit (30 Oct 2026 late night)

- Owner check: see `docs/setup-status.md` "30 Oct 2026 (late night) — access owner check recorded…" (steps 1, 2, 5 passed; the approval part of steps 3 / 4 open because no approval was stored).
- Browser checks: `scripts/e2e/lib/e2e-auth.mjs` (real login, per-run throwaway accounts in a DB copy, CSRF header); 8 scripts pass; 4 history-bound scripts not converted (listed there).
- Approval audit: approve / revoke / payment start write their audit row in the same transaction as the decision (approval store connection); refusals best-effort with a logged failure. This supersedes "audit after COMMIT" in §8.

- **Correction (30 Oct late night, close):** the owner confirmed all five steps passed, including the approval part; the acceptance stands. Because `2e4399a` changed the approve transaction after the check, re-assign → approve → remove is re-checked once ("re-check after the fix", `docs/setup-status.md`).

## 11. Phase close-out (31 Oct 2026)

- Owner re-check after `2e4399a` (re-assign → approve → remove → *No longer valid*): **passed**; DB, computed-validity and automated evidence recorded separately in `docs/setup-status.md` "31 Oct 2026 — access phase close-out". Phase **complete for the local single-machine demo**.
- The four remaining browser scripts (extraction, comparison, clarification, search-budget) now sign in for real; parts that exist only on old unowned records are asserted 404 or reported "not reachable", never passed.
- `tests/access.test.ts` world: approval store now shares the fixed test clock (a mixed real / fixed clock made the removal look older than the approval after 2026-10-31T02:00Z).
- **R-ACCESS-CLOCK (open at the afternoon close; fixed the same evening, §12):** `grantRevokedSince()` compares timestamps only and payment has no separate "still assigned" check, so a backwards clock step between approval and removal would hide the removal. Proposed: compare by grant `seq` recorded at approval time (no migration) + a backwards-clock test. Fix or explicit acceptance required before multi-user deployment.

## 12. Payment-authorisation fix R-ACCESS-CLOCK (31 Oct 2026 evening, schema v17)

- **Order:** `approver_grants.seq` (INTEGER PRIMARY KEY AUTOINCREMENT, append-only, written in serialised transactions) = commit order. Ids and timestamps are not used for ordering.
- **Approve:** inside the approve transaction the approver's newest grant row is read through the approval store's connection; it must be a GRANT; its `seq` is stored in `approvals.approver_grant_seq`. Trigger `approvals_grant_basis` refuses an APPROVER approval that does not name a GRANT of the same request and approver.
- **Validity / payment:** `APPROVER_UNASSIGNED` iff a REVOKE with a higher `seq` exists or the approver is not assigned now (re-assign never restores). Read inside `startPayment` and inside the order / capture guard (payment store's write transaction, with the claim) — never from a page or an event. Approver approvals from before v17 (no `seq`): `GRANT_BASIS_UNKNOWN`, never payable, new approval needed; nothing back-filled.
- **Unchanged boundaries:** check + claim in one short transaction, PayPal after COMMIT; a claimed / sent capture is not recalled; PAID and unknown outcomes kept.
- **Evidence:** 6 tests (`tests/access.test.ts`, "approver removal is ordered by the database, not by the clock"); 3 failed on the old code (one reached PAID after removal, MOCK), all pass after the fix; `npm test` 412/412. Migration v17: backup, rehearsal, restore drill, applied (all rows identical; new column NULL). Details: `docs/setup-status.md` "31 Oct 2026 (evening)".

## 13. Usability round (31 Oct 2026 night) — no change to who may do what

- The Quotes page shows an approval entry for the selected version: the assigned approver gets "Review and approve this version", the owning buyer "View approval preview and status" (never an approve control). The link names version and run; the approval page and the server decide, as before, who may approve (`canApproveRequest`) and pay (`canPayRequest`).
- **R-ACCESS-CLOCK:** recorded as fixed, automated verification passed (owner decision, 31 Oct night); not owner-verified. Concurrency evidence = the transaction orders tested (a removal inside a capture's claim transaction is serialised after it), not every possible race.
- **31 Oct night, later:** removing an approver makes the request 404 for them until re-assigned (unchanged rule; the acceptance text now says so). Re-assignment restores reading, never an earlier approval. The approval page now hides Approve while an approval is Active; that is feedback only — the server's request key and one-active rule decide.

## Approver assignment limits (owner decision, 2 Nov 2026)

- **No cumulative cap** on how often an owner assigns / removes an approver on a request.
- A repeated assignment (already assigned) or removal (not assigned) is `UNCHANGED`: no grant row, no audit row. Every real change appends one grant row with a new `seq`.
- Re-assignment never restores an approval made under an earlier grant: a later REVOKE (by `seq`) keeps it No longer valid (`APPROVER_UNASSIGNED`); a new approval is needed.
- ~~Pre-freeze to-do, not built: a short-time limit on assignment changes.~~ **Built 3 Nov — see below.** Removing an approver is never blocked or delayed.
- Evidence: `tests/access.test.ts` ("repeated assignment adds nothing; no cumulative limit…", "re-assign does not restore it", "removed and re-assigned (clock stepped back)"); owner's MOCK acceptance data 2 Nov (`docs/setup-status.md` "2 Nov 2026 (evening)").

## Short-time assignment limit (built 3 Nov 2026; owner rules of 3 Nov)

- **Rule:** the same buyer on the same request may make at most **10 real new GRANTs within a rolling 10 minutes** (`ASSIGN_LIMIT`, `ASSIGN_WINDOW_MS` in `src/server/auth/service.ts`). The 11th gets **HTTP 429 `ASSIGNMENT_RATE_LIMITED`** with `retryAfterSeconds` and a `Retry-After` header; the message says nothing was changed and that removal is never limited. The current assignment is not changed; nothing retries automatically. No cumulative cap.
- **Not counted:** repeated GRANT of an assigned approver and repeated REVOKE (both UNCHANGED, no row — checked *before* the limit), refused requests (no grant row), REVOKE rows.
- **Removal:** REVOKE never goes through the limit check; it still needs sign-in, ownership, CSRF and a valid approver id.
- **Where it is counted:** from the persisted `approver_grants` rows (`actor_id` = the signed-in buyer, `action = 'GRANT'`, `created_at` inside the window) **inside the same `BEGIN IMMEDIATE` transaction** as the insert and its audit row — two concurrent requests cannot both take the last place. The refusal writes one `access_audit` row (`APPROVER_ASSIGN`, DENIED, reason RATE_LIMITED). No new table, column or migration; no external service; no history row is changed.
- **Time:** used only for the window. Approval validity still uses grant `seq` only (re-assigning never restores an old approval). A restart keeps the limit (rows are persistent). A backwards clock step can make the wait longer (rows look newer — only assigning is affected); a forward step can shorten it. The local single-process server serialises requests anyway; the transaction is what makes it safe across processes.
- **Evidence:** `tests/access.test.ts` — 3 new tests with a controlled clock (10 allowed / 11th refused with 600 s; 1 s before the window ends still refused, at 10 min allowed; repeated GRANT costs nothing; removal at the limit; repeated removal writes nothing; restart with a new store; re-assign after the window keeps the old approval invalid; rolling window with 30 s steps; another request independent; Buyer B / approver / signed out / wrong CSRF write nothing and use up nothing; two connections racing for the last place → exactly 10). Mutation check: with the limit check disabled all 3 fail. The older "no cumulative cap" test now spaces its 22 changes 2 min apart (the cumulative claim is unchanged). Browser: `access.e2e` 21/21 after the change; one scripted probe on a copy (removal at the limit works; the 11th assignment shows the message; row stays unassigned).
