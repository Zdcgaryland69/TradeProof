# Supplier reply tracking and question numbers (28 Oct 2026, reworked the same day)

> **State:** built 28 Oct as schema v11, fixed the same night as v12 (`7114eac`), extended 29 Oct as **v13** after the owner's second review ("29 Oct additions" below). Rules `reply-tracking-2026-10-29.1`, copy format `copy-2026-10-28.1`.
> **Owner acceptance: passed 29 Oct 2026 (SGT)**, five steps on `PR-6117B2A1`. Owner-seen vs automated-only per row: `docs/design-24oct-additions.md` R1–R14 and `docs/setup-status.md` → "29 Oct 2026 — owner accepted supplier reply tracking". Earlier owner acceptances (23–27 Oct) are unchanged.
> No model, no translation service, no PayPal call. TradeProof sends nothing.

## 29 Oct additions (owner's second review)

| # | Requirement | Before (v12, `7114eac`) | Now (v13) | Evidence |
| --- | --- | --- | --- | --- |
| D1 | Duplicate submission ≠ same content | Same text in the same series was **merged** (returned the earlier reply as `DUPLICATE`, nothing written) | **Fixed.** Same key + same payload → the original row (replay). Same key + other payload (text, date, channel, sender, source, correction) → refused. A new key with identical text → **a new reply** with its own received date, channel and source, flagged "Same text as reply N — possible duplicate" (both ways); never merged | unit "same key … new key keeps an identical text"; HTTP 201 + `possibleDuplicateOf`; e2e reply 2 |
| D2 | Basis covers the draft's version, run and reviews | Request revision + latest quote version only | **Fixed (basis-2).** Request revision, latest quote version, sent draft revision, the draft's run (and base run), the **newest finished run** of the version, and the **reviews** of the draft's runs. Any change → "Recorded on an earlier basis — review again" with the reasons; history kept; nothing inherited. v12 answers (two-field basis) show "recorded before the draft run and reviews were part of the basis"; v11 answers "basis not recorded" | unit basis tests (review, newer run, request, version); e2e review → `REVIEWS_CHANGED`, new version → `NEWER_QUOTE_VERSION` |
| D3 | Four separate states | "Updated quote needed" shown for every non-pairing statement | **Fixed.** Each question shows four facts: *Reply received (linked)* · *Your reading recorded* (or on an earlier basis) · *Quote update: none / needed / manual review* · *Deal: not approved* (always, in this phase) | e2e facts |
| D4 | Confirms original / new condition / cannot judge | Not distinguished | **Fixed (schema v13).** The buyer classifies each statement: *confirms the condition the saved quote already states* (no quote update), *proposes a new or changed condition* (updated quote needed), *cannot be judged* (manual review). Older unclassified statements → manual review. A statement always needs a classification (validation + DB trigger). Item pairing is never a term change (manual review) | unit; e2e Q1 / Q2 / Q3 |
| D5 | No statement becomes a payment amount | `usableAsApprovedTerm: false` | Kept, plus `usableAsPaymentAmount: false` on every statement | unit |
| D6 | A linked new quote version is not verified | Line said "extract and compare that version" | **Fixed.** Each link shows *extraction: not run / N finished run(s) · comparison: not verified by TradeProof · approval: not approved*. `updatedQuoteStatus()` returns `comparisonRecorded: false, approved: false`. The 29–30 Oct approval step must check extraction, comparison and approval of that version **on the server** (plan) | unit; e2e |
| D7 | Repeatable browser check | One-shot on append-only test data | **Fixed.** Each run seeds a new `[TEST] e2e replies <time> (SYNTHETIC)` record (MOCK replay, no model call). The network check flags any http / https / ws connection to another host and ignores only `data:` / `blob:` | 4 full runs (see Tests) |

**Schema v13** (next free number; one column `clarification_answers.statement_kind` with a CHECK, plus an insert-time trigger; no row changed). Rehearsed on a copy and applied to the local DB with backups (setup-status).

## Requirement review (28 Oct night)

What the first version (v11, `5d93915`) did against what was authorised, and what the fix changed. "Test" names the automated evidence. "Owner-seen" is empty everywhere: acceptance is open.

| # | Requirement | v11 (first version) | Now (v12) | Evidence |
| --- | --- | --- | --- | --- |
| 1 | An ordinary reply is kept on its own and is not a quote | **Gap.** The reply had to be saved as a quote version / supplement. It became the "latest saved" quote, made drafts of the asked version report `NEWER_QUOTE_VERSION`, and could be extracted and compared as revised terms | **Fixed.** `supplier_replies` holds the text as received, per quote series. No quote version is written, the latest quote and the draft basis are unchanged, and a reply is never extracted or compared | unit "a reply is not a quote version"; e2e: versions unchanged, basis notice unchanged |
| 1b | Only explicit quote updates create a linked quote version | Not separated | **Fixed.** An updated quote is saved on the Quotes page as before. The user may record "this reply led to quote version N" (`supplier_reply_quote_links`, append-only); nothing is created by that | unit "updated quote is linked explicitly" |
| 2 | Stable identifiers on cards, check result, copied text and reply links | **Partly. Deviation:** the copied text had list numbers only; cards, the check result and reply links had Q numbers | **Fixed.** The copy reads `2. [Q3] …` (list number kept + Q number) and ends with `Reference: CD-XXXXXXXX (Q numbers refer to the questions in this message).` / `参考编号：…`. Saved revisions are not rewritten | unit copy test; e2e copied text |
| 2b | Q-number scope stated; no cross-draft matching by "Q1" | Implicit only | **Fixed.** The page states that Q numbers belong to this draft (`CD-…`). Answers are keyed by (draft, stable question id); nothing parses "Q1" from a reply | e2e scope note; code has no text matching |
| 3a | Receiving a reply does not resolve a question | Done | Done: saving or linking a reply leaves every question open | unit + e2e |
| 3b | Source and "supplier identity not verified" labels | **Gap** | **Fixed.** Source label (Pasted by you / Test data / Carried over), "sender not verified", sender as written, received date, channel | e2e reply card |
| 3c | Unassigned replies | **Gap** (a reply existed only as a link) | **Fixed.** A reply belongs to the quote series. Unlinked replies show "Not assigned to any draft" and can be linked later. **Limit:** they are listed on the draft pages of that quote only; there is no list on the Quotes page | unit; e2e |
| 3d | One reply → several questions | Done | Done | unit |
| 3e | Several replies | Done | Done: the history continues across replies, and each excerpt is checked against its own reply | unit; e2e |
| 3f | Contradictory records | **Gap** (newest reading silently won) | **Fixed** as a flag on conflicting buyer readings: the newest readings that the buyer recorded from different replies differ (status, statement or classification). TradeProof compares the recorded readings only; it does not read the reply texts for semantic contradictions. `buyerStatements()` returns `contradicted: true`; nothing is resolved automatically | unit; e2e; owner step 4 |
| 3g | Corrections keep the original | Answers: done (append-only). Reply text: **gap** | **Fixed.** A corrected paste is a new reply naming the one it corrects; the original stays. Answers stay append-only with history | unit |
| 3h | Duplicate submission protection | Done for links / answers | Done, plus the same reply text in the same series → `DUPLICATE`, nothing written | unit; e2e |
| 3i | Concurrent edits | Done (409) | Done | unit; e2e two tabs |
| 3j | A basis change does not inherit old confirmations | **Gap** (only a regenerated draft started fresh) | **Fixed.** Each answer stores its basis: request revision + latest quote version. When either changes, the answer shows "recorded on an earlier basis — review again" and `basisCurrent: false`. v11 answers have no recorded basis and are never current. A regenerated draft starts with all questions open | unit; e2e (carried-over answers) |
| 3k | "Confirmed term" is the buyer's reviewed statement | **Gap** (wording "Term confirmed by you") | **Fixed.** Renamed **buyer statement**: "Your reviewed statement (buyer's statement) … not the supplier's agreement to this wording, not an approved term and not a payment amount". The values check says that values in the reply do not mean the supplier agreed | e2e wording |
| 3l | Commercial terms need an updated quote | **Gap** | **Fixed.** Every field except item pairing is marked **"Updated quote needed"**, among them amount, currency, quantity, material, lead time, payment terms, trade term, fees, logo and specification. `buyerStatements()` returns `usableAsApprovedTerm: false` for every statement: approval must use a compared quote version | unit; e2e |
| 4 | Production build | Not run | **Run once with the dev server stopped: PASS** | `npm run build` log |

**Not built (open):**
- a list of a quote's replies on the Quotes page;
- removing a wrong "reply → updated quote" link (it is append-only and cannot be withdrawn);
- automatic detection that a linked updated quote was actually extracted and compared (the page only says to do it).

## How it works now

1. **Paste a reply** (draft page → *Supplier replies 供应商回复* → *Paste a supplier reply*).
   - What is stored: the text as received; received date, channel and sender as written (all optional, sender not verified).
   - It may name an earlier paste it corrects.
   - It is linked to this draft by default, with the draft revision the user says they sent. Untick to leave it unassigned.
2. **Updated quote.** If the supplier sent a new quote, save it on the Quotes page as a version. On the reply, record *This reply led to an updated quote version*.
3. **Answers per question.**
   - The user records answers / partly / does not answer, choosing the reply when there are several.
   - The excerpt must occur verbatim in that reply's text: page warning, server refusal (422) and DB trigger.
4. **Buyer statement** (only with "answers it").
   - The user's own reviewed wording, checked deterministically for values not in the excerpt.
   - Flags shown: *Updated quote needed* / *manual review* (from the classification), *earlier basis* and *conflicting readings* (the buyer's recorded readings from different replies differ — not a semantic analysis of the replies).
5. **Copy** (unchanged steps): each listed question shows `[Qn]`, and the message ends with the draft reference.

States per question: *Open — no answer recorded* · *Open — not answered in the reply* · *Open — partly answered* · *Answered — your reading* · *Answered — your reviewed statement recorded*. None of them is an approval.

## Storage (schema v12, `src/server/replies/schema-sql.ts`)

| Table | Holds | Rules (DB triggers / constraints) |
| --- | --- | --- |
| `supplier_replies` | request, series, text + SHA-256, source, received date, channel, sender as typed, `from_quote_version_id` (carried-over rows only), `corrects_reply_id`, save key | Immutable. Series belongs to the request; a correction stays in the same series; `MIGRATED_FROM_QUOTE_VERSION` ⇔ from-version set |
| `supplier_reply_quote_links` | reply → quote version (the user's statement) | Append-only; same series; one per pair |
| `clarification_replies` (rebuilt) | draft ↔ supplier reply, sent revision, note | Immutable; same series; the sent revision exists; one per pair |
| `clarification_answers` (rebuilt) | per-question reading: status, excerpt, `buyer_statement` (was `confirmed_term`), note, `basis_json` (new), supersedes | Append-only; linear history per (draft, question); question belongs to the draft; excerpt occurs in the linked reply's text |

**Migration v11 → v12** (28 Oct night). It follows SQLite's table-rebuild procedure:
- the migration runner now turns foreign keys off around the transaction, runs `PRAGMA foreign_key_check` before COMMIT (any violation → rollback) and turns them back on;
- v11 / v12 steps skip a file whose reply tables are already v12-shaped (older-version test fixtures).

How each v11 row is carried over:
- **Reply link:** becomes a supplier reply whose text is copied from the quote version it was read from (`MIGRATED_FROM_QUOTE_VERSION`). That quote version stays as it is: versions are immutable.
- **Link ids:** kept.
- **Answer ids, history and statements:** kept.
- **Basis:** `NULL`, i.e. "not recorded".

Rehearsed on a copy, then applied to the local DB with backups (`docs/setup-status.md`).

## Code

| Part | Where |
| --- | --- |
| Pure rules (numbers, validation, statement check, basis, conflicting readings, classification) | `src/lib/replies.ts` |
| Copy format with Q numbers and draft reference | `assemble()` / `shortDraftRef()` in `src/lib/clarification.ts` |
| Store / service / HTTP | `src/server/replies/` (ownership via `policy.ts`) |
| Routes | `POST /api/procurements/:id/quotes/:seriesId/replies`, `POST …/replies/:replyId/quote-links`, `GET/POST /api/procurements/:id/clarification-drafts/:draftId/replies`, `POST …/answers` |
| Page | `ReplyTracker.tsx`, `DraftEditor.tsx` (numbers, copy); strings `en.replies` |

## Tests

**29 Oct (v13):**
- **`tests/replies.test.ts`, 20 tests.** New: classification, basis (review / newer run), updated-quote status, v12 → v13 migration. Changed: duplicates, buyer statement, basis.
- **Full suite:** **347/347**.
- **Browser** (`npm run e2e:replies`, headless Edge, each run on its own seeded record), 4 full runs: **26/26, 24/26, 26/26, 26/26**.
  - **Run 2 failure:** one React hydration mismatch, plus the dev error overlay's request it triggered (`POST /__nextjs_original-stack-frames`).
  - **Cause, from the dev-server log diff (`- open=""` on a reply card's `<details>`):** the script opened a `<details>` element before React had hydrated. A test timing fault, not the page. The script now waits for hydration after every navigation and opens it with a real click.
  - **Run 4 (fixed script):** 26/26 and no hydration message in the dev log.
  - **After a dev-server restart:** `--verify` **6/6**; the 27 Oct `e2e:clarify -- --verify` **6/6**.

**28 Oct night (v12), kept for the record:**

- **`tests/replies.test.ts`, 16 tests.** At least one per row of the review table, plus:
  - DB triggers;
  - no model / PayPal / budget / quote / extraction / draft writes;
  - HTTP;
  - the v11 → v12 migration carrying real v11-shaped rows.
- **Copy-format test** in `tests/clarification.test.ts`. Migration fixtures in `clarification.test.ts` and `quotes.test.ts` were adjusted for the new tables (fixture change only).
- **Full suite:** **343/343**.
- **Browser** (`npm run e2e:replies`, headless Edge, on the [TEST] browser-check draft with its carried-over reply):
  - **Full run: 19/20.** The 20th check ("no other host contacted") failed only because the new date input's built-in calendar icon is a `data:` URI. A read-only probe confirmed it is the only such entry and is not a network request, and the server log shows only the allowed endpoints. The rule now ignores `data:` URIs.
  - **The full run is one-shot** on its test data: rows are append-only, so a second full run sees its own earlier rows. That is why a third attempt failed early; it wrote nothing (one duplicate save and one existing link, both 200).
  - **After a dev-server restart:** `--verify` **5/5**; the 27 Oct `e2e:clarify -- --verify` still passes **6/6**.
