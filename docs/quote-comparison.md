# Quote comparison (deterministic)

> Added 23 Oct 2026 (phase 2b, part 1). Library + tests only: no page, no API route, no AI call yet.
> **26 Oct 2026: wired to stored extraction runs** — see "Comparator on stored extractions (26 Oct)" below (page, API, binding, review rules, cost boundaries). The 23 Oct library and its rules below are unchanged and still tested.

## Why it is split this way

Extraction (reading a supplier quote) and judgement (deciding what disagrees) are separate steps:

1. **Extraction** turns a quote document into an `ExtractedQuote` (`src/lib/quote.ts`). Every value carries `source`, the verbatim text it was read from. Later this is done by the runtime AI model; today two hand-written reference extractions stand in for it.
2. **Source check**: `unverifiedSources(documentText, quote)` lists every field whose source text is not in the document (whitespace-insensitive), and every value given without a source. Extraction output that fails this check is rejected, not shown.
3. **Comparison**: `compareQuote(request, quotes, { asOf })` (`src/lib/quote-compare.ts`) is plain code with no AI and no exchange rates. It compares a stored procurement request against one or more quote documents (e.g. a Chinese quotation and the supplier's English summary) and returns findings, high severity first.

So the model can be wrong about *what the document says* (and the person sees the source to check), but never decides *whether it is a problem*.

## Request side

`comparableFromRecord(record)` reads a stored request. Request fields are free text, so small parsers recognise clear wording only: stainless grade (`304`, `SUS304`, `316L` …), logo method and colour count (EN/ZH keywords), deposit percent and balance timing, Incoterm rule (from *Ship from* or *Additional requirements*). Unrecognised wording becomes `null` and the comparator reports `cannot_compare` (low) rather than passing silently.

## Rules

| Field | Finding type | Severity | When |
| --- | --- | --- | --- |
| items | `item_count_mismatch` | high | Number of item lines differs (lines are matched by position) |
| material | `spec_mismatch` | high | A document states a different grade |
| material | `spec_not_stated` | medium | No conflict, but a document does not state the grade |
| logo | `spec_mismatch_with_extra_cost` | medium | Method/colours differ **and** the requested method appears as an extra charge |
| logo | `spec_mismatch` / `spec_not_stated` | medium | Method/colours differ / not stated |
| quantity | `quantity_mismatch_between_languages` | high | Quote documents disagree with each other |
| quantity | `quantity_mismatch` | high | Documents agree but differ from the request |
| currency_and_amount | `currency_mismatch_needs_confirmation` | high | Documents use different currencies, or a currency other than the budget's. **Never converted** |
| currency_and_amount | `total_arithmetic_mismatch` | high | Σ unit price × quantity ≠ stated total (integer minor units) |
| currency_and_amount | `over_budget` | high | Total (or Σ unit × qty) in the budget currency is above the cap; equal is fine |
| incoterm | `incoterm_mismatch` | high | Incoterm rule differs (place is not compared: "宁波" vs "Ningbo") |
| lead_time | `lead_time_inconsistent` | medium | Documents state different days / start / "about"; summary gives the latest deposit date that still meets the ship-by date |
| lead_time | `lead_time_too_late` | high | Only with `asOf`: deposit on `asOf` + longest lead time is after the ship-by date |
| payment_terms | `payment_terms_mismatch_between_languages` | high | Documents disagree with each other |
| payment_terms | `payment_terms_mismatch` | high | Documents agree but differ from accepted terms |
| any | `cannot_compare` | low | Request wording not recognised while the quote states a value |

Each finding has `request` (the request text) and `quotes[]` with `documentId`, `language`, a display `value` ("not stated" when missing) and the verbatim `source`.

## Reference data (SYNTHETIC)

`samples/synthetic/extracted-quote-zh.synthetic.json` and `extracted-quote-en.synthetic.json` are hand-written reference extractions of the two synthetic quote documents. They are the expected output for evaluating the AI extraction step later.

Against the demo request ("Load demo") with `asOf = 2026-10-23`, the comparator returns exactly the 6 findings in `expected-discrepancies.synthetic.json` (same field, type and severity) and nothing else.

## Tests (`tests/quote.test.ts`, 28)

Reference extraction sources are verbatim; a fabricated source and a value without a source are rejected; the 6 seeded findings and no extras; evidence per document; a matching quote → no findings; one test per rule including boundaries (exactly at budget, ship date reached exactly); unrecognised request wording → `cannot_compare`; parsers. Mutation check on 23 Oct: four hand-made bugs in the comparator (quantity check, surcharge type, budget boundary, deposit-deadline date) each made a test fail.

## Binding to stored quotes (from 23 Oct)

Quotes are now stored as immutable versions with a request snapshot (`docs/quotes.md`). When wired up (25 Oct), an extraction result belongs to one quote **version id**, and a comparison runs on (that extraction, the version's request snapshot or a named request revision) and records both. Extraction must read the version's `contentKind`: for a `SUPPLEMENT`, terms not mentioned keep the earlier version's value (*not mentioned*), and only *explicitly changed* or *contradicting* terms are reported as such.

## Comparator on stored extractions (26 Oct)

Code: `src/lib/comparison.ts` (pure, `compareExtraction`, `runRefusal`, `userConfirmedMatches`), `src/server/comparison/` (read-only service, HTTP), page `src/app/procurements/[id]/quotes/compare/page.tsx`, strings `en.comparison` in `src/i18n/en.ts`. Comparator version `compare-2026-10-26.1`. Purpose: **this request (as saved with this quote version) vs. this quote version**, not a supplier ranking.

**Computed on demand, nothing stored, no schema change.** Opening, refreshing, choosing another run or restarting never starts an extraction, a review or a model call: the page is server-rendered, the API is GET only, and the comparison code imports no model, adapter or run entry point (checked by a test).

| Topic | Rule |
| --- | --- |
| Inputs | Read on the server: the version's stored text (SHA-256 **re-computed** and compared with the stored hash), the request snapshot saved with the version and its revision, the run, the run's own reviews, the current request revision (only to report a change). The browser names ids only (`?run=`, `?baseRun=`); any other query parameter → 422 |
| Ownership | Run of another request → 404 (not this request's data). Run of another version of the same request, run hash ≠ version hash, run's request revision ≠ snapshot revision, unfinished run, result checked with older value rules, wrong supplement base → **refused** (409 / page notice with the reason). Older-rules runs stay viewable in the extraction panel, never a comparison basis. Access goes through `canReadRequest` (same entry point as extraction / search) |
| Basis | Always the snapshot saved with the version. If the request changed since, the page says so ("still uses revision N … not switched automatically"); to compare with the newer revision, save the quote again as a new version |
| Run choice | The page names the run in the address (opening without one picks the newest usable run and writes it into the URL, so a refresh keeps it). All runs of the version are listed with why a run cannot be used. Fields are never combined across runs |
| Supplement | Uses only the version it was explicitly linked to (`supplements_version_id`), never the latest. Per term: stated in the supplement / changed by it (base value shown) / inherited from the base run (labelled with its version) / unresolved (no usable base run). Supplement items do not merge with base lines; no cost subtotal for a supplement |
| Items | Paired by stable line ids: the user's `MATCH_ITEM` / `NO_MATCH` review wins; otherwise a single valid model proposal is used **labelled "proposed — not confirmed"**; ambiguous, unmatched, unknown ids (incl. an old choice that is not a snapshot line) need a choice; two quote items on one line are not compared (quantities never summed); a request line with no item is "not quoted". Never by position |
| Values used | Latest review of that field **in this run**: CONFIRM → model value (confirmed by you); CORRECT → the user's text read by field type (quantity, money with a named currency, currency code, enum code, text) — labelled "your statement"; unreadable → not used; REJECT → no value. Model value, excerpt and check outcome stay visible. Stored results are never changed |
| Outcomes | Consistent / Difference / Needs clarification (missing, ambiguous, cannot compare). Review state is shown separately; consistent ≠ confirmed. Free-text specification is never judged by code |
| Terms | Quantity (+ unit wording), material grade, logo method / colours, unit price (unknown → open), currency vs budget (never converted), goods total vs budget cap (fees not included), Σ unit price × quantity vs total (exact integers), Incoterm rule (place not compared), lead time vs ship date (Singapore day), payment terms (only a cleanly parsed deposit / balance is compared). Wording like "to be agreed", "TBC", "待定", "样品确认后" → **open condition**; any other wording code cannot parse is also open — the phrase list only adds a reason |
| Fees | GOODS lines → suspected repeat (equal to total / unit price / line subtotal), not added, original kept. Unknown amount (never 0), unclear currency (never USD), unknown inclusion, not firm, per-unit (which items / quantities not linked → never allocated or multiplied), unknown basis → open. Included / not applicable → not added. Only lump-sum, not-included, firm fees with a known amount are "known extras", per currency |
| Known amounts | Per currency: stated goods total, Σ item lines, known extras. Always labelled **not a total cost** (open items and possibly unmentioned costs); `paymentAmount` is always null |
| Output use | `DISCREPANCIES_AND_QUESTIONS_ONLY`: differences and a draft list of clarification questions (copy only, nothing sent). `userConfirmedMatches()` returns only matching rows whose values the user confirmed or corrected on a user-chosen pairing — the only input the 29–30 Oct approval step may build on |

**Tests** (`tests/comparison.test.ts`, 28): pure tests on the **stored** real-model runs LA-1 … LA-5 exactly as stored on 25 Oct (exported read-only by `scripts/export-stored-runs.mjs` to `samples/synthetic/live-acceptance/stored-runs.synthetic.json`); service / HTTP tests on temporary databases with a counting test double that replays the stored model output through the normal checks. Mutation check: 11/11 hand-made bugs caught (position pairing, ignored corrections, cross-run reviews, GOODS added, per-unit treated as known, older rules accepted, hash unchecked, not-agreed compared, bare amount read as USD, base run from a non-linked version, cross-request run). Browser: `npm run e2e:compare` (see the script header).

**Limits:** the comparison is only as good as the stored extraction and the user's review; code reads a small set of clear patterns (grades, logo methods, Incoterm rules, deposit / balance, "N days after deposit") and leaves everything else open; units are compared by a short synonym list; no supplier ranking, no exchange rates, no approval or payment.

## Not done yet

Storing findings (not needed: computed on demand), approval binding confirmed terms (29–30 Oct). The bilingual clarification draft and its deterministic check were **built 27 Oct** from this comparison's Difference / Needs-clarification rows and open fees (`docs/clarification-drafts.md`). For that, `requestLines` also carries each line's quantity and unit (display only; comparator rules unchanged). Earlier note (23–25 Oct): discrepancy table page and matching item lines by item id instead of position — done 26 Oct above. Since 24 Oct, `toComparatorQuote` (`src/server/extraction/check.ts`) turns a checked extraction (SUPPORTED facts only, never a supplement) into `ExtractedQuote`. A test shows that the MOCK outputs of the two SYNTHETIC quotes give the same 6 seeded findings as the hand-written reference extractions. The real AI step has no provider yet (`docs/quote-extraction.md`). Quote paste and storage exist since 23 Oct (`docs/quotes.md`).
