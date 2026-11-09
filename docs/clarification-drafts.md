# Bilingual clarification drafts and the deterministic check (27 Oct 2026)

> Built 27 Oct 2026. Schema **v10**. **Owner-accepted 27 Oct evening** (five manual steps; owner-seen vs automated-only per row in `docs/design-24oct-additions.md` CL1–CL7 and `docs/setup-status.md` → "27 Oct 2026 (evening)").
> Labels: a draft is a **Template-generated draft / Review before sending**. It is not an AI result and not a checked translation. TradeProof never sends it.

## What it does

From one accepted comparison (one quote version + one extraction run, `docs/quote-comparison.md`) the server builds clarification questions for the supplier in **English and Simplified Chinese** with **paired templates**. No model and no translation service is involved. The user chooses which questions go into the message, edits either language, saves, and copies the English or the Chinese text into their own channel.

A deterministic check compares the two languages **per question** with each other and with the values the comparison gave.

| Part | Where |
| --- | --- |
| Templates, generation, content validation, copy text, check | `src/lib/clarification.ts` (pure, no I/O; runs on the server and in the browser) |
| Storage (schema v10) | `src/server/clarification/schema-sql.ts`, `store.ts` |
| Service (ownership via `policy.ts`, comparison recomputed via `ComparisonService`) | `src/server/clarification/service.ts` |
| HTTP | `src/server/clarification/http.ts`; routes `…/versions/:versionId/clarification-drafts` (GET list, POST create) and `/api/procurements/:id/clarification-drafts/:draftId` (GET, PUT) |
| Pages | entry on the comparison page (`compare/CreateDraftButton.tsx`); draft page `/procurements/:id/quotes/drafts/:draftId` (`DraftEditor.tsx`) |
| Strings | `en.clarification` in `src/i18n/en.ts`. The Chinese template text lives with the templates (it is message content, not UI) |

## Where questions come from

- **Server only.** The create request names a run (and, for a supplement, a base run) and nothing else; unknown fields are refused (422).
- The server recomputes the comparison from stored records. The same rules apply as on the comparison page: hash re-computed, snapshot revision, run ownership, older value-check rules refused, and a supplement's base must be its explicitly linked version.
- Only **Difference** and **Needs clarification** rows and **open / suspected-duplicate fee lines** produce questions. Consistent rows never do.
- If there is nothing to ask, the draft says so. No filler question is generated.
- **Each question keeps:**
  - a stable id: template + comparison row key or fee key, e.g. `MATERIAL_DIFFERS:material-THIS_VERSION-0`;
  - the row / fee, field, outcome and note (why it is asked);
  - the request line id and quote item index, and whether the pairing was only the model's proposal;
  - every value it relies on: path, run, version, the user's review state and review id.
- **The draft stores what it was generated from:**
  - request id and snapshot revision, plus the current request revision at the time;
  - quote version id / number and text SHA-256, and the newest version number at the time;
  - run id / mode / model / rules;
  - review count and newest review id per run;
  - comparator version, `asOf` day, template version and a digest of the generated questions.
- **Points the buyer settles first** are listed separately as "for you to settle first" and never put into the message:
  - pairing choices;
  - the buyer's own unrecognised wording;
  - the buyer's own unreadable correction;
  - unresolved supplement inheritance;
  - "total cannot be checked";
  - a budget in another currency.
- **Offered but not selected by default:**
  - the suspected repeat of the goods price;
  - the free-text specification confirmation;
  - "over budget", which is marked **Tells the supplier your budget**.
- **Merging.** A question merges with another only when template, item line and both texts are identical; all origins are kept. Questions about other items, currencies or versions have different texts or lines, so they never merge.

### Wording rules (templates `clarify-template-2026-10-27.1`)

- **Request vs quote.** The request side reads "our request specifies / our proposal is". The quote side reads "**as we read your quote**, it states …" (ZH "我方理解贵方报价写的是…"). A model value is never written as an agreed fact.
- **Kept as written.** Item names and quoted wording (request text, quote text, model values) appear inside “…” as written. They are **not translated**, and the page says so.
- **Examples:**
  - material 304 requested, quote states 201 → ask whether 304 can be supplied and how unit price and lead time would change;
  - Σ unit price × quantity ≠ total → state both, ask for the correct quantities / prices and the revised total;
  - unknown freight → ask for the amount and currency, whether it is included, whether it is firm, and who bears it;
  - per-unit fee with unknown scope → ask which items and quantity it applies to and whether it comes on top of the item prices (as read);
  - terms "to be agreed" → "please state the … you propose; until it is agreed in writing, we treat this point as open". The supplier is never committed to anything.
- **Closing.** The default closing says nothing above confirms any term.

## Saving, versions, conflicts

- **Draft row.** Holds the source snapshot, the generated questions and the template version. It is immutable (triggers refuse UPDATE / DELETE).
- **Texts.** They live in append-only revisions:
  - revision 1 = generated text (`GENERATED`); later revisions = the user's saves (`USER_EDIT`);
  - revisions must be consecutive (trigger);
  - the generated text is always available, and edited questions are labelled **edited**.
- **One draft per basis** (re-checked 27 Oct evening: after a basis change, the first Create makes one new draft; further Creates, and "Generate a new draft" on the older draft, return that draft while the basis stays unchanged). A unique index on (version, run, base run, source fingerprint) means repeated or concurrent presses, refresh, back or a second tab return the same draft (`EXISTING`, 200) and write nothing.
- **Save rules:**
  - each save carries `expectedRevision` and a `saveKey`;
  - a stale tab → 409, nothing written; the page keeps its text and offers to load the saved version;
  - unchanged content → "No changes to save.", nothing written;
  - same key + same content → replay; same key + other content → refused.
- **Content validation.**
  - The draft's own question ids only, a text for every question in both languages, ≤ 2000 characters each, no control characters, ≤ 96 KB.
  - Unknown fields are refused, e.g. `amount` or `sent`.
  - Texts are the user's words. They are checked, never used as amounts, terms or comparison results.
- **Deselecting.** A deselected question keeps its text and stays **open**; leaving it out settles nothing.
- **Copying.** Copy English / Copy Chinese builds: opening, then the numbered selected questions, then closing.
  - **Numbering:** the copy is renumbered 1…n over the **selected** questions in original (generated) order. Leaving out original 6 of 7 copies originals 1–5 and 7 as 1–6. The copied text contains no ids.
  - **Link back:** the saved revision's `selected` is the ordered list of stable question ids; copied number *n* is its *n*-th id. On the page, each card shows its source key under "Source of this question"; the check result uses the original numbers. The page does not show the copied number next to each card.
  - Copying writes nothing and marks nothing as sent, answered or confirmed. With pending items the page warns first: check not run on this text, inconsistencies, parts needing review, unsaved text. Copying is still allowed.

### When the basis changes

Opening a draft recomputes the comparison only to report changes:

| Code | Meaning |
| --- | --- |
| `REQUEST_REVISED` | The request was changed after generation |
| `NEWER_QUOTE_VERSION` | A newer quote version was saved |
| `REVIEWS_CHANGED` | Reviews of the run or base run changed |
| `NEWER_RUN` | A newer usable run exists for the version |
| `QUESTIONS_CHANGED` | The comparison now gives different questions |
| `TEMPLATE_CHANGED` | The question templates have changed |
| `BASIS_NOT_USABLE` | The run can no longer be compared; the reason is shown |

- The saved draft stays exactly as it is: no silent rewrite and no re-binding to a newer run or version.
- **Generate a new draft from the current comparison** is an explicit button. It uses the newer run if there is one, links the new draft to the old one (`supersedes_id`), and keeps the old draft with its edits.

## The deterministic check (`bilingual-check-2026-10-27.1`)

The check runs per part: the opening, each selected question, and the closing. Each language is compared with the generated text of that part (built from stored values) and with the other language.

| Read | How |
| --- | --- |
| Quoted text “…” / 「…」 / "…" | Compared verbatim (NFKC, whitespace collapsed); numbers inside quotes are not read as values |
| Numbers | Existing number reader (`src/server/extraction/numbers.ts`, rules of 25 Oct). Role: amount with currency, count with unit, measure, percentage, code, plain number. Ambiguous formats (`1.800,00`, `1.500`, `1 500`) are never guessed |
| Currencies | Codes and words (`USD`, `US$`, `美元`, `CNY`, `RMB`, `人民币` …). A bare `$`, `¥` or `￥` → cannot be read |
| Units | Count groups (pcs / 件 / 个, sets / 套, boxes / 盒, cartons / 箱, pairs / 双, bottles / 瓶); measures (days / 天 / 日, ml / 毫升 …) |
| Charging basis | per unit / 按件 / 每件 vs per order / 按单 / lump sum / 一次性 |
| Dates | ISO `2026-11-01` and `2026年11月1日`. `03/04/2026`, or a date in words → cannot be read |
| Trade-term codes | EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP (upper case) |
| Numbers in words | e.g. "thirty", "百分之三十", "五百件" → cannot be read |

**Findings.** `MISSING` (in one language), `MISSING_BOTH`, `CHANGED` (same kind, different value), `ADDED` (only in one language), `EMPTY` → **Inconsistent**. `ADDED_BOTH` (same in both but not from the comparison), `UNREADABLE`, `EDITED` (wording changed from the template) → **Needs your review**. Nothing found → **No inconsistencies found within the supported rules**, always shown with "this is not a sign-off".

**Stale results.** The result is tied to the exact text checked. Any edit hides it ("Out of date … run the check again") until the user runs the check again.

**Never shown.** No green state, no "verified translation", no percentages.

### Limits (what the check cannot know)

- **Meaning is not checked.** Negation ("not included" ↔ "included"), conditions, who bears what, commercial intent and tone are not compared. That is why any edited wording is "needs your review", even when every number matches.
- **Set comparison.** Values are compared as a set per part: a change in how many times the same value occurs (e.g. one of two identical amounts removed or added) can be missed. Order and which sentence a value sits in are not checked.
- **Unedited means template pairs.** For an unedited draft the check confirms only that the paired templates carry the same values. It does not show that the questions are complete or right for the deal: that depends on the stored extraction, the user's reviews and the comparison.
- **Scope.** Only English ↔ Simplified Chinese. No other language is offered. Full quote translation and the AI semantic check (design §5.1, A7 / A8 AI part) are **not built**; they need the owner's go-ahead.
- **Not built in this phase:** sending, supplier portal, reply tracking (next), approval, payment.

## Tests

- **Unit / service / HTTP / migration.** `tests/clarification.test.ts`, 29 tests (28 on 27 Oct, plus the idempotency-after-basis-change test the same evening):
  - generation on the stored LA-1 / LA-3 / LA-5 runs, with in-memory request edits for differences: wording, item pairing under reorder, unknown amount / currency / terms / fee owner, merge, no-question case, markup kept as text, stable ids;
  - the check: number, currency, percentage, date, trade term, unit, basis and quote changes located per question and language; missing / added / empty; negation → review; unreadable formats; stale key; copy text; content validation;
  - temp-DB store and service: one draft per basis, revisions, unchanged save, conflict, replay, key reuse, basis changes with explicit regeneration, ownership / cross-record refusal, restart, append-only triggers;
  - no model / PayPal: call counter, ledger, runs, reviews, versions and payments unchanged; static import check;
  - HTTP: guard, unknown fields, 404, 409;
  - v9 → v10 migration with backup and unchanged rows.
- **Mutation check (27 Oct).** 8/8 hand-made bugs caught: quotes ignored, edits not reported, ambiguous numbers accepted, quantities swapped, optional questions selected, merge across items, added value passes, unit-price question lost.
- **Browser.** `npm run e2e:clarify` (22 checks), and `-- --verify` after a dev-server restart (6 checks).
