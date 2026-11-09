# Procurement requests (drafts)

> Added 22 Oct 2026 (phase 2a). Local development only — no login yet. Drafts only: no approval, no payment link.

## Pages

| Path | What |
| --- | --- |
| `/procurements` | List (newest update first), empty state, "New request"; **search box** (25 Oct, `?q=`): Request ID / `PR-` / `QS-` / supplier quote numbers in every quote version / title / quote name — see `docs/design-24oct-additions.md` §3.2a |
| `/procurements/new` | Form; **Load demo (SYNTHETIC)** fills it from `samples/synthetic/purchase-request.synthetic.json` — nothing is saved until the user clicks *Save draft* |
| `/procurements/[id]` | Read-only detail with a **Quotes** section → *Edit* → same form (item rows can be moved up / down; each shows its line id or "new line"); save / cancel |
| `/procurements/[id]/quotes` | Quote series and versions (`docs/quotes.md`) |
| `/procurements/[id]/history` | **Revision history** (schema v8): stored revisions, newest first, `Current` marked; `?revision=N` shows that revision read-only ("Viewing revision N"), with *Back to current revision*. Only the current revision links to editing |

Home page has a "Procurement requests" button. Each request shows a short reference `PR-XXXXXXXX` (first 8 hex digits of its id; display only). The detail page shows the **Request ID** (the full `pr_…` key) with *Copy Request ID*. Every item line shows its **Item reference** `IT-XXXXXXXX` (first 8 hex of the line id `pri_…`) with *Copy*, which copies the full id. The detail page, the editor and the quote snapshot show the same reference for the same line; it does not change on rename, quantity change or reorder (schema v7, 24 Oct). A new, unsaved line shows "new line (reference assigned on save)". Data-source tags (SYNTHETIC / DEMO, User input, Source not recorded) and the demo banner come from the stored `source`, never from the title. Pages and API answer only in `next dev` with a loopback Host (`src/proxy.ts` refuses everything else before rendering; pages and handlers repeat the checks).

## API (JSON, `Cache-Control: no-store`)

| Method / path | Result |
| --- | --- |
| `GET /api/procurements` | `{ requests: Summary[] }` |
| `GET /api/procurements/search?q=&field=&sort=` | `{ query, key, category, sort, hits, total, totalRequests, truncated, ambiguous, notes }` · 422 `INVALID_QUERY` (also for an unknown `field` / `sort`) (25 Oct) |
| `POST /api/procurements` (optional `source`: `USER_INPUT` default, or `DEMO_SAMPLE`) | 201 `{ record }` · 422 `{ errors: [{ field, message }] }` |
| `GET /api/procurements/:id` | 200 `{ record }` · 404 |
| `GET /api/procurements/:id/revisions` | `{ revisions: [{ revision, origin, savedAt, archivedAt, current }] }` · 404 |
| `GET /api/procurements/:id/revisions/:revision` | `{ revision: { …, snapshotVersion, snapshot } }` · 404 when not stored |
| `PUT /api/procurements/:id` body `{ revision, ...fields }`; every item carries `id` (existing line id, or `null` for a new line) | 200 `{ record }` (revision + 1, new history row) · **200 `NO_CHANGES`** "No changes to save." when nothing differs (nothing written) · **409 `{ code: "CONFLICT", current }`** if `revision` is stale — nothing written · 422 (incl. an `id` that is not a line of this request, a duplicate or a malformed id) · **422 `CLIENT_OUTDATED`** if items have no `id` key (page loaded before schema v6: refresh) · 404 |

Common refusals: production → 404; non-loopback Host → 403; POST/PUT without same-origin loopback `Origin` → 403; not `application/json` → 415; body > 256 KiB → 413 (read as a stream, stops at the limit); bad JSON → 400. Unknown fields (e.g. `status`, `id`, `createdAt`) → 422: the server sets them.

## Data model (SQLite schema v9 — v9 adds only the API budget ledger, same local file as the payment records, separate tables)

`procurement_requests`: `id` (`pr_<uuid>`, server-generated) · `title` (required) · `buyer_type` (v7: `BUSINESS` | `INDIVIDUAL` | NULL = not recorded) · `buyer_company` · `buyer_person_name` (v7, ≤ 200) · `supplier_name` (NULL = TBD; never used to choose a PayPal payee) · `ship_from` · `ship_to` · `budget_currency` (USD / SGD / CNY — budget only, not payment currencies) · `budget_max_minor` (integer cents, NULL = no cap, 0 allowed) · `required_ship_date` · `expected_delivery_date` (`YYYY-MM-DD` text, no time zone) · `payment_terms` · `additional_requirements` · `status` (`DRAFT` only) · `source` (schema v5: `USER_INPUT` | `DEMO_SAMPLE` | NULL = not recorded for rows created before v5; set once on create, never changed by edits, display only — not used for permissions or payment) · `revision` (integer, starts at 1) · `created_at` / `updated_at` (UTC ISO-8601).

`procurement_request_items` (schema v6): `id` (`pri_<uuid>`, server-generated, primary key) · `request_id` · `position` (display order only, unique per request) · `name` (required) · `quantity` (positive integer or NULL) · `unit` · `material` · `specification` · `customization` (logo etc.) · `notes`. A save, in the same transaction as the request row: deletes lines whose id was not sent, updates lines by id (id unchanged, new position), inserts `id: null` lines with a fresh random id. Ids are never reused; same names stay separate lines. Before writing, every submitted id is checked against the request's current lines (other requests' ids, removed lines and forged ids → 422, nothing written).

Rules enforced on the server (`src/server/procurement/validate.ts`) and again by CHECK constraints: empty → NULL (never 0); quantity whole number 1 … 100,000,000; budget text with ≤ 2 decimals, not negative, parsed without floating point; real calendar dates 2000-01-01 … 2100-12-31; single-line short fields; no control characters; length limits (title 200, item spec 2,000, additional requirements 4,000 … see `src/lib/procurement.ts`); 1 … 50 items.

`revision` is optimistic concurrency (`UPDATE … WHERE id = ? AND revision = ?`), and since schema v8 each revision a save creates is also stored as a snapshot (below). It is not an approval.

## Saves that change nothing (24 Oct fix)

Until 24 Oct, every *Save draft* increased `revision` and `updated_at`, even when nothing had changed (found in the owner's acceptance: one test request went from revision 2 to 8). The cause: `ProcurementStore.update` always ran `revision = revision + 1` without comparing anything. *Edit* and *Cancel* never sent a request; only *Save* did.

Now the server decides inside the save transaction, after the revision check, so a stale page still gets **409**:

- The submitted form goes through the same validation and normalisation as any save (trim, CR LF → LF, empty → null). It is then compared with the stored record: every business field, plus every item line's full id, content and **order**.
- Equal → **200 `NO_CHANGES`** "No changes to save." Nothing is written: same revision, same `updated_at`, no history row. The page shows "No changes to save.", never "Saved as revision N+1". A saved quote linked to this revision therefore does not show "The request has been updated since".
- Any real difference changes the revision as before: case, inner spaces, item order, an added or removed line, a name, a quantity or the buyer type. Leading and trailing spaces were already trimmed by the existing rules, so they do not count.

## Revision history (schema v8, 24 Oct)

`procurement_request_revisions`: one row per (request, revision) — `origin` (`SAVED` | `MIGRATION_BASELINE`), `snapshot_version`, `snapshot` (the `RequestSnapshot` v2 shape also used by quote versions: the full record with buyer fields and item lines with their ids), `business_time` (when that revision was saved = the request's `updated_at` then) and `archived_at` (when the row was written).

- Create writes the request, its items and the revision 1 snapshot in **one transaction**. A save with a real change writes the new revision and its snapshot in one transaction too. If the snapshot cannot be written, the whole save is rolled back (tested). Unchanged saves, refused saves and 409 conflicts write no row.
- Database rules (triggers + CHECKs): a snapshot can only record the request's **current** revision and `updated_at`, and its JSON must name the same id and revision. A request can move only to revision N+1, and only when revision N is recorded, so there are no gaps from the first stored revision on. Rows can never be updated or deleted, and a request with history cannot be deleted.
- History is read from the snapshots only, not from the current item table, so a deleted line still shows in older revisions with its original id. Item references (`IT-…`) are the same on the detail page, the editor, the history and quote snapshots.
- No "saved by" is recorded: there is no sign-in yet. The page says "Saved by: not recorded".

**Gap before 24 Oct.** Requests that existed at the migration got one `MIGRATION_BASELINE` row: their real state at that moment, stored as their current revision. Its business time is the request's own `updated_at`, its archive time the migration time; the two are shown separately. Earlier revisions were never stored. They are listed as unavailable ("Revisions 1–8 were saved before history was recorded; they were not deleted, they were never stored, and they are not reconstructed") and are not rebuilt from current data. Quote versions keep their own request snapshots for their own purpose; they are not merged into this history.

Not built (by decision): restoring an old revision, deleting history, field-by-field diff.

## Migration

`src/server/db/database.ts` holds all migrations (payment v1–v3 unchanged, v4 procurement tables, v5 `source` column added only if missing, v6 item ids + quote tables, v7 buyer columns + extraction / supplier-number tables, v8 request revision history with one baseline row per existing request, v9 the API budget ledger (new table only, 25 Oct) — additive only; see `docs/setup-status.md` for the 24 Oct backups and checks). v6 rebuilds the item table once, giving each existing line one new id in the same order with the same values; it is skipped when the `id` column already exists, so reopening or re-running never regenerates ids. Before migrating an existing file it writes a consistent copy with `VACUUM INTO` to `data/backups/<file>.v<from>-before-v<to>.<UTC time>.sqlite` (Git-ignored); if the copy fails nothing is migrated. The version is re-read inside the write lock, so two processes cannot migrate twice. No database is opened at build or import time.

## Demo sample mapping

From `purchase-request.synthetic.json` (unchanged; the six seeded discrepancies still apply): title prefixed `[SYNTHETIC / DEMO]`; buyer company; supplier empty (sample names none); ship from "China (FOB Ningbo)" and ship to "Singapore (SG)" (derived from incoterm and buyer country); USD, cap 1800.00; required ship date 2026-12-10 (the sample has a ship-by date, not an arrival date, so *expected delivery* stays empty); payment terms; item: 500 pcs, 304 stainless steel, "500 ml, Matte black", "Logo: Laser engraving, 1 colour"; additional requirements note the source file, incoterm and max unit price USD 3.60.

## Browser check for edit conflicts

`npm run e2e:conflict` (with `npm run dev` running) opens two headless Edge tabs on one new `[TEST]` draft. The script checks that a stale save gets 409, that the DB keeps the first save, and that the conflict message is visible in a 1280×800 window. Added after a manual test found the message rendered off screen.

## Buyer type (schema v7, 24 Oct)

| Type | Fields in the form |
| --- | --- |
| Business | *Company name* (required), *Contact name* (optional) |
| Individual | *Your name* (required), *Company / Organization* (optional) |

- Required for new requests (422 otherwise). Requests created before v7 read **"Buyer type not recorded"**. Nothing was inferred from `buyer_company` or `source`. On edit they may stay not recorded ("Not recorded (keep as is)") until the user picks a type. Once recorded, a type cannot be cleared (422).
- Changes go through the same `revision` check: a stale tab gets 409 and cannot switch the type back.
- **Display and wording only.** The type is not the PayPal account type, and it never changes payment permission, approval, PayPal protection, the payee or any confirmation step. The payment module does not read it (a test checks this).
- Quote versions saved from v7 on store request snapshot **v2**, which includes the buyer fields. v1 snapshots (23 Oct) show "Buyer type: not recorded at the time" and are never back-filled.

## Planned changes (designed 24 Oct, not built)

Ownership / access control (28 Oct, expected schema **v11** — v10 is the clarification drafts, 27 Oct). Search on the list page was built 25 Oct. Design: `docs/design-24oct-additions.md`.

## Not in this phase

Comparison on stored quotes, bilingual messages, approval, linking to payment, webhooks, export, delete, login. (Quote import and versions: `docs/quotes.md`.)
