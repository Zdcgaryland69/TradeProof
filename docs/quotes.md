# Supplier quotes: series and immutable versions

> Added 23 Oct 2026 (schema v6). Local development only, like the procurement pages. Pasted plain text only: no PDF, images, OCR, email or URL fetching. Since 24 Oct (v7) a saved version can be extracted by AI on request — derived rows only, never changing the version (`docs/quote-extraction.md`; no real model connected yet).

## Model

```text
procurement_requests (revision N)         one request
  └─ procurement_request_items (id pri_…)  stable line ids (v6)
  └─ quote_series (id qs_…)               one per supplier quote; name + supplier display name; immutable
       └─ quote_versions (id qv_…)        v1, v2, … append-only; never updated or deleted
            ├─ raw_text + raw_text_sha256
            ├─ content_kind FULL_QUOTE | SUPPLEMENT (+ supplements_version_id, same series)
            ├─ source USER_PASTE | DEMO_SAMPLE | TEST_FIXTURE, source_note, supplier_quote_date
            ├─ revision_note               the user's own description (not verified)
            ├─ request_revision            request revision linked at save time
            └─ request_snapshot            full request JSON at that revision, item ids included
quote_save_keys (idempotency key → fingerprint, version)
```

| Field | Meaning | Does NOT mean |
| --- | --- | --- |
| `raw_text` | Exactly the text received by the server (not trimmed, rewrapped, normalised or translated) | — |
| `raw_text_sha256` | SHA-256 of the stored UTF-8 text, for consistency checks | Proof of who wrote it or that it is genuine |
| `supplier_display_name` | What the user typed | A verified identity; it never chooses or changes a PayPal payee |
| `content_kind` | The user's declaration: complete quote, or a supplement / fragment of an earlier version | That the supplement replaces anything; unmentioned terms are not cancelled; nothing is merged |
| `revision_note` | The user's note on this revision ("supplier added freight") | A checked or AI-verified finding |
| `request_snapshot` | The request linked when this version was saved | That the supplier received, accepted or promised to meet it |
| latest version | The last one saved | Accepted, confirmed or approved |

Saving a version never confirms, accepts or approves a quote and does not enable payment. Snapshots start with this feature; earlier request history was not recorded and is not reconstructed.

Immutability is enforced twice: the app has no update / delete path, and SQLite triggers refuse `UPDATE` / `DELETE` on `quote_versions` and `quote_series` (and `UPDATE` on `quote_save_keys`). A cross-series supplement is also refused by a trigger.

## API (JSON, `Cache-Control: no-store`, same local-only guard as `/api/procurements`)

| Method / path | Body | Result |
| --- | --- | --- |
| `GET /api/procurements/:id/quotes` | — | `{ series: [{ …, versions: [summary] }] }` |
| `POST /api/procurements/:id/quotes` | `idempotencyKey`, `expectedRequestRevision`, `name`, `supplierDisplayName?`, `rawText`, `contentKind` (must be `FULL_QUOTE`), `source`, `sourceNote?`, `supplierQuoteDate?`, `revisionNote?` | 201 `{ series, version }` |
| `POST /api/procurements/:id/quotes/:seriesId/versions` | as above without name / supplier (inherited from the series), plus `expectedLatestVersionId`, and `supplementsVersionId` for a `SUPPLEMENT` | 201 `{ series, version }` |
| `GET /api/procurements/:id/quotes/:seriesId/versions/:versionId` | — | `{ version }` with `rawText` and `requestSnapshot` |

Other results: **200 `REPLAYED`** — same idempotency key and same content (returns the original version, even if newer versions or request revisions exist since); **409 `VERSION_CONFLICT`** (+ `latest`) — the version you based on is no longer the latest; **409 `REQUEST_CHANGED`** (+ `currentRevision`) — the request changed after the page loaded; **422 `IDEMPOTENCY_KEY_REUSED`** — same key, different content (or another request / endpoint); **422 `VALIDATION_FAILED`**; **404** when request, series and version do not belong together (no information about other requests). Unknown fields — `versionNumber`, `savedAt`, `rawTextSha256`, `requestSnapshot`, `id`, … — are refused: the server sets them. Same text in different requests is allowed (the hash is not a key).

Order of checks inside one `BEGIN IMMEDIATE` transaction: idempotency key → series belongs to request → expected latest version → expected request revision → supplement target in the same series → insert version + key.

## Limits and text handling

- Text 1 … 100,000 characters (code points); body ≤ 1 MiB; name / supplier ≤ 200; source note ≤ 500; revision note ≤ 1,000; quote date `YYYY-MM-DD` (real date, 2000–2100).
- `trim()` is used only to reject blank text. Refused (not altered): control characters other than tab / LF / CR, unpaired surrogates.
- Line endings: a browser text box reports line breaks as LF, so text pasted in the UI is stored with LF. The API stores whatever it receives (CR LF included) and hashes exactly that.
- Display: React text only (HTML / scripts are shown as text); line numbers are drawn by CSS from a data attribute, so they are never part of the stored or copied text.

## UI

`/procurements/[id]` → **Quotes** section → `/procurements/[id]/quotes`:

1. *New quote*: name, supplier display name (pre-filled from the request's supplier, editable), content type (full quote by default, with a prompt to check), text, quote date, source (Pasted by user / Test data), source note, revision note → **Preview** (exact text with line numbers) → **Save version 1**.
2. *Add revision*: name and supplier inherited; full quote or supplement (choose the version it adds to) → Preview → Save as version N+1.
3. Version tabs; the view shows source, content kind, "Latest saved — not accepted", revision note "written by the user; not verified", hash, the text, and the linked request snapshot. If the request has changed since: "The request has been updated since (now revision M). This quote was saved linked to revision N."
4. Refusals keep the input and are shown on screen (version conflict → "Save mine as version N+1" after reviewing; request changed → "Link to revision M instead"; network failure → Save again is safe). Unsaved text warns before leaving.
5. **Load demo**: Chinese quotation or English summary from `samples/synthetic` (files only read; LF line endings), source `DEMO_SAMPLE`, name / supplier marked fictional. There is no synthetic *revised* quote; browser checks use text explicitly marked `[TEST]` with source *Test data*.

## 24 Oct (schema v7)

- New snapshots are `snapshotVersion: 2` (with buyer type and person name). Existing v1 snapshots are read as they are and never rewritten. Item lines in the snapshot show their **Item reference** `IT-…`.
- Each version view has an **AI extraction** panel bound to that version id and hash (`docs/quote-extraction.md`).
- Supplier quote number per version: `quote_version_supplier_refs` (append-only). AI candidates carry an excerpt from the version text, and only the user's confirmation or entry counts as the value. Entering a number in the composer at save time is **not built yet**.

## Planned changes (designed 24 Oct, not built)

Quote rename as an append-only log (series stay immutable), entering the supplier quote number at save time, original language and translations as separate records, search across all versions. Old versions and their triggers are not changed by any of this. See `docs/design-24oct-additions.md` §2–§5 and §7.

## Tests

`tests/quotes.test.ts` (unit / store / HTTP) and `npm run e2e:quotes` (+ `-- --verify` after restarting `npm run dev`). Results are recorded in `docs/setup-status.md`.
