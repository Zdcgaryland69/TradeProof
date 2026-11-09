# AI extraction of saved quote versions

> Added 24 Oct 2026 (schema v7). Local development only, same guard as the other procurement pages.
> **25 Oct 2026 (night): real model connected** — Anthropic `claude-sonnet-5-5`, owner-approved budget (see "Live model (Anthropic)"). Five SYNTHETIC real-model runs: `docs/live-model-acceptance.md` (US$0.069710 local estimate; **accepted by the owner** 25 Oct). Before that, everything was built and tested with test doubles and a clearly labelled **MOCK**; MOCK runs stay labelled as such.
> **25 Oct acceptance (owner):** old-rules notice, not-configured refusal, MOCK run with current rules and the old run unchanged — passed; restart persistence by automated checks only. **Real-model acceptance still not done.**
> **25 Oct:** the two blockers found on 24 Oct are fixed — number-aware value checks (rules `value-check-2026-10-25.1`, "Value checks" below) and the overall API budget (schema v9, "API budget" below). A real call is still impossible until the owner approves a provider, model and spend, an adapter exists, and the budget variables are filled in.

## What it does

From one **saved quote version** the server extracts, with evidence:

- supplier quote number candidates;
- items: name, quantity, unit, material, specification, logo, unit price, and **proposed** links to request item lines;
- currency, total, quote date, trade term, lead time, payment terms;
- fees and costs (goods, freight, insurance, taxes / duties, customs services, payment fees, packaging, other), each with amount, currency, amount basis (per unit / lump sum), who pays, who receives, included in the quote or not, and how the text states it (firm / estimate / to be confirmed / not applicable).

## Three things never mixed up

| Layer | Where | Meaning |
| --- | --- | --- |
| Model value | `modelValue`, `modelExcerpt`, run `raw_output` | What the model said. Kept for review and audit, never trusted on its own |
| Source excerpt found — review required | `check`, `evidence`, `valueCheck`; `value` set only when `check = SUPPORTED` | The **server** found the excerpt in **this version's stored text** and the value inside it under the value-check rules. **Not** a semantic check (25 Oct wording; the internal name `SUPPORTED` is unchanged) |
| Confirmed by the user | `quote_extraction_reviews` (append-only) | The user checked it against the text. "Confirmed" means "matches the pasted text", not "verified with the supplier" |

Check outcomes (`src/lib/extraction.ts`): `SUPPORTED`, `NOT_STATED`, `NO_EXCERPT`, `NOT_IN_TEXT`, `ONLY_IN_CONTEXT` (found only in the earlier version given as context), `VALUE_NOT_IN_EXCERPT`, `SUSPICIOUS_EXCERPT` (the excerpt's line addresses the assistant), `INVALID_VALUE`, and from 25 Oct `AMBIGUOUS_VALUE` (number format, currency or unit can be read more than one way). Anything other than `SUPPORTED` / `NOT_STATED` makes the run **INCOMPLETE**, and that value is unknown. A missing amount is never 0. A payer or payee is never invented. Tax rates are never guessed.

*Interpreted* fields (fee kind, payer, payee, included, stated-as, amount basis) need an excerpt that exists. The value is the model's reading of it, and the page says so.

## Value checks (25 Oct, rules `value-check-2026-10-25.1`)

Replaces the 24 Oct substring test (`contains()`), under which quantity `500` was "found" in `1500 pcs` and USD 3.20 in `USD 13.20`. Code: `src/server/extraction/numbers.ts`; tests: `tests/numbers.test.ts` (22).

- The excerpt is scanned into **number tokens with digit boundaries**. Each token keeps its exact original text and offsets (full-width digits stay as written; NFKC is used only for reading). Normalisation never rewrites the stored text or the evidence.
- Each token gets a **role** from its neighbours: `MONEY` (currency marker next to it: `USD`, `US$`, `S$`, `RMB`, `人民币`, `元`, …; a bare `$` / `¥` is ambiguous), `COUNT` (`pcs`, `sets`, `个`, `件`, …), `MEASURE` (`ml`, `kg`, `mm`, `days`, `毫升`, `天`, `个月`, …), `PERCENT`, `CODE` (glued to letters or joined by `-` `/` `_`, or after `No.`, `#`, `SKU`, `Model`, `型号`, `货号`, `编号` …: `BT-500`, `BT500`, `500A`) or `BARE`.
- **By field type:** a quantity matches only a `COUNT` or `BARE` token with the same integer; an amount only a `MONEY` token in the claimed currency, or a `BARE` token when the excerpt names exactly that one currency; a percentage only a `PERCENT` token; text values (names, terms, supplier numbers) must not start or end inside a longer number (`QT-118` is not in `QT-1185`, `30%` not in `130%`).
- Values are compared as exact numbers: `3.2` = `3.20`, `1,700.00` = `1700.00`; `3.205` ≠ `3.20`.
- **Ambiguous → `AMBIGUOUS_VALUE`, never guessed:** `1.500`, `1,80`, `1.800,00`, a full-width comma (`１，５００` — often a list separator in Chinese), space grouping (`1 500`), and a bare number when the excerpt names several currencies.
- A value occurring several times is a match; all places are listed and a note says which one belongs to the field is not checked.
- **What this proves:** the value occurs as a number of the right kind inside the cited excerpt, and the excerpt occurs in this version's text. **What it does not prove:** that it belongs to the right item, line or fee (a test documents that a quantity cited from another item's line still passes), negations or conditions, or the meaning of interpreted fields.
- **Rule version:** every new result stores `checkRules` and per fact `valueCheck` (field type, outcome, offsets, note); `EXTRACTION_SCHEMA_VERSION` is now `extraction-result-2`. Results stored before 25 Oct have no `checkRules`: they keep their actual scope (`value-check-2026-10-24.0-substring`), the page says "checked with earlier rules … not re-checked", and `toComparatorQuote` refuses them. Nothing old is relabelled or rewritten (finished runs are immutable).
- **Page wording:** the excerpt pill says **"Source excerpt found — review required"** (amber, not green); below it, separately, the **value check** line and the **review state** ("Pending your review" / "Confirmed by you"). Run status: "Finished — source excerpts found for all values; review required".

## API budget (25 Oct, schema v9)

Code: `src/server/budget/` (config, store, schema), `src/lib/budget.ts`; tests: `tests/budget.test.ts` (20). Applies to **LIVE** calls only; MOCK runs never touch it. No price is built in.

| Rule | Behaviour |
| --- | --- |
| Configuration | Environment, read per call (names in `.env.example`): `AI_BUDGET_APPROVED` (= `yes`), `AI_BUDGET_CURRENCY` (billing currency, 3 capitals), total and daily amount limits, total and daily call limits, `AI_PRICE_PROVIDER` / `AI_PRICE_MODEL` (must equal `AI_PROVIDER` / `AI_MODEL`), input and output price per 1M tokens (> 0), per-request fee (may be 0). Anything missing, unapproved, zero-priced or for another model → `503 BUDGET_NOT_CONFIGURED`, no run row, no call |
| Scope | All requests, quote series and versions together. The per-version limit (3 LIVE runs / 24 h) stays, but is not the budget |
| Before each attempt | One `BEGIN IMMEDIATE` transaction (SQLite write lock, so safe across connections and processes) checks calls + 1 and spend + this attempt's **upper bound** against the daily and total limits, then inserts a `RESERVED` row. Refused → `FAILED / BUDGET_EXHAUSTED`, attempts 0, `429`, no call (does not use the per-version cap). A retry needs its own reservation; if refused, the retry is not sent. **Ledger not writable** (e.g. still locked after the 5 s busy timeout, 26 Oct) → `FAILED / BUDGET_UNAVAILABLE`, attempts 0, `503`, the database error in the message, nothing sent, not retried. If the run's FAILED status cannot be written either (lock still held), the error surfaces (HTTP 500), the row stays `RUNNING` — not reported as saved — and the next start on that version after `STALE_RUNNING_MS` closes it as `FAILED / INTERRUPTED` ("outcome unknown"). An error **after** an attempt is never classed as "not sent": the reservation stays counted at its full amount (if even closing it fails, it stays `RESERVED`, which counts the same, and the stale sweep later marks it `UNKNOWN`) |
| Upper bound | Input: UTF-8 bytes of the complete prompt (system + user, incl. supplement context and request snapshot) + 1,000 tokens overhead — valid for byte-level tokenizers, to confirm for the chosen provider. Output: the 4,000-token cap. Plus the per-request fee. Integer arithmetic, rounded up |
| After the attempt | Usage reported → `SETTLED` (estimate at the reservation's prices). Definitely not sent (adapter says so) → `RELEASED`. Timeout, error, reply without usage → `UNKNOWN`: the full reservation stays counted as spent, no exact cost is invented |
| Idempotency | Key `<run id>#<attempt>` is unique: a repeat is never reserved or sent again; settling twice changes nothing; closed rows are immutable and never deleted (triggers) |
| Restart / crash | A `RESERVED` row older than 90 s becomes `UNKNOWN` (counted, never released, never re-sent). The run itself is closed as `INTERRUPTED` as before |
| Money | Integer micro-units (1/1,000,000) of one named currency. Spend recorded in another currency blocks real calls (nothing is converted) |
| Day | Singapore calendar day (UTC+08:00). Restarts, config, model or price changes never reset totals |
| Page | Extraction panel → "API budget": settled estimate, pending (in flight or outcome unknown), available, calls used / limit — today and total; per run, each attempt's state. Labelled as a local estimate, not the provider's bill, limiting only calls through this app (not the whole provider account) |

## Live model (Anthropic) — owner-approved 25 Oct 2026

**Authorisation (owner, 25 Oct):** Anthropic Claude API (direct), Claude Sonnet 5.5, ledger currency USD; US$1 and 20 calls per day; US$5 and 100 calls in total for this phase; no automatic budget increase, top-up, subscription, other paid model or higher limits. Part of the S$100 project cap, not extra. Claude Code subscriptions do not cover the app's API calls.

**Verified from official docs on 25 Oct 2026 (SGT):**

| Fact | Value | Source |
| --- | --- | --- |
| Model ID / alias | `claude-sonnet-5-5` (dateless ID is a pinned snapshot); 1M context; 128K max output; retirement not before 28 Sep 2027 | <https://platform.claude.com/docs/en/about-claude/models/overview> |
| Standard price | input **US$2 / MTok**, output **US$10 / MTok**; 5-min cache write $2.50, 1-h $4, cache read $0.10 (not used); no long-context surcharge on Sonnet 5.5; `inference_geo: "us"` = **1.1x**; batch 50 % (not used) | <https://platform.claude.com/docs/en/about-claude/pricing> |
| Thinking | Thinking tokens are billed as output and count toward the strict `max_tokens`. `thinking: {type: "disabled"}` → 400 on Sonnet 5.5; `{type: "between_tools"}` turns off up-front thinking (allowed at effort ≤ high); without tools the reply is text only | <https://platform.claude.com/docs/en/build-with-claude/thinking> |
| Token counting | `POST /v1/messages/count_tokens`: free (own rate limit), an **estimate** that "might differ by a small amount"; system-added tokens are not billed | <https://platform.claude.com/docs/en/build-with-claude/token-counting> |
| Structured outputs | Supported on Sonnet 5.5, but max 16 union-typed (e.g. nullable) parameters; truncation at `max_tokens` can return invalid JSON | <https://platform.claude.com/docs/en/build-with-claude/structured-outputs> |
| Errors / retries | SDK retries connection errors, 429 and 5xx twice by default (`maxRetries` disables it); docs say nothing about errored requests being unbilled | <https://platform.claude.com/docs/en/api/errors> |
| Account access | Not verifiable from the docs for this account; the first real call (or a 401 / 403 / 404 on token counting, which is free) shows it | — |

**Adapter** (`src/server/extraction/anthropic.ts`, `@anthropic-ai/sdk` **1.3.0**, pinned): one HTTP request per attempt; SDK `maxRetries: 0`; the call policy never retries its errors; `max_tokens` 4,000; `thinking: {type: "between_tools"}`, effort `high`; system + one user message; **no** tools, web search, caching, `inference_geo`, refusal fallbacks (a fallback would run another paid model) or structured outputs (the schema has far more nullable fields than the 16-union limit — the existing strict parser refuses any other shape as `INVALID_OUTPUT`). Only `claude-sonnet-5-5` is accepted for `anthropic` (`ANTHROPIC_APPROVED_MODELS`); any other `AI_MODEL` → NOT_CONFIGURED. The key is passed explicitly from `AI_API_KEY`, used only on the server, never logged, stored or returned.

**Budget with the adapter:** before sending, the server counts the exact request (free) and reserves `(count × 1.1 + 256)` input tokens + 4,000 output tokens at the configured prices, × **1.1** headroom (a workspace default of US-only routing would cost 1.1x) — atomically, in the v9 ledger. If counting fails, nothing is sent and nothing is reserved (`TOKEN_COUNT_FAILED`). After the reply: usage priced at US$2 / US$10 → `SETTLED` with the provider request id; cache tokens, a non-global region, a non-standard tier or another serving model → `UNKNOWN` (reservation kept). Timeouts, network errors and HTTP errors after sending → `UNKNOWN`, never retried. Refusal (`stop_reason: "refusal"`) → `FAILED / REFUSED` and settled (billed). Invalid JSON or truncation → `FAILED`, settled, no "repair" call.

**Configuration** — `.env.local` (owner fills it; names as in `.env.example`; the key is the only secret):

| Variable | Value |
| --- | --- |
| `AI_PROVIDER` | `anthropic` |
| `AI_MODEL` | `claude-sonnet-5-5` |
| `AI_API_KEY` | *the owner's Anthropic API key (never shared)* |
| `AI_BUDGET_APPROVED` | `yes` |
| `AI_BUDGET_CURRENCY` | `USD` |
| `AI_BUDGET_DAILY_LIMIT` / `AI_BUDGET_TOTAL_LIMIT` | `1.00` / `5.00` |
| `AI_BUDGET_DAILY_MAX_CALLS` / `AI_BUDGET_TOTAL_MAX_CALLS` | `20` / `100` |
| `AI_PRICE_PROVIDER` / `AI_PRICE_MODEL` | `anthropic` / `claude-sonnet-5-5` |
| `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` / `AI_PRICE_PER_REQUEST` | `2` / `10` / `0` |

Restart `npm run dev` after editing (environment is read at start). The local ledger only limits calls made through this app; set a spend limit in the Anthropic Console as well if a hard account-wide cap is wanted.

**Acceptance cases:** `samples/synthetic/live-acceptance/` (five SYNTHETIC cases, expectations in `expected.md` written before any call); runner `node scripts/live-acceptance.mjs LA-1` (one request per invocation; a second invocation re-sends the same key and must replay).

## Deterministic code, not the model

- Amounts: the text as written (`"11,760.00"`) is parsed into integer minor units. Ambiguous forms (`1.800,00`, `1,80`) → invalid. The currency must be named in the excerpt (`USD`/`US$`/`美元`, `SGD`/`S$`, `CNY`/`RMB`/`人民币`/`元`). A bare `$` or `¥` names none. Nothing is converted.
- Arithmetic: Σ quantity × unit price against the stated total (BigInt, same currency only).
- Cost overview (display only): the quoted total plus **lump-sum, firm** fees that the text says are **not included**. Every other fee (unknown amount or inclusion, per-unit, optional) is counted as unknown, never summed as 0. Currencies are never added together. **Nothing here sets a payment amount or a PayPal payee.**
- "Firm" without a supported amount is downgraded to "to be confirmed" (the model's word is kept).
- Adapter to the 23 Oct comparator (`toComparatorQuote`): only SUPPORTED facts. A **supplement returns null**: it is never compared as a full quote.

## Item matching

- The model may propose request item ids. The server keeps only ids that are lines of the **request snapshot this version was saved with** (not today's request); others go to `rejectedIds`.
- 1 valid candidate → `PROPOSED` (still needs confirmation); several → `AMBIGUOUS`; none → `UNMATCHED`. Nothing is ever matched by position or confirmed automatically.
- The user picks a line (`MATCH_ITEM`, refused if not in that snapshot) or `NO_MATCH`.

## Supplements and context

For a `SUPPLEMENT`, the version it adds to is sent as a separately labelled context block. Excerpts are checked against the supplement's own text only. A term that occurs only in the earlier version gets `ONLY_IN_CONTEXT` and no value. Silence is not cancellation.

## Quote text is data

The text sits between boundary markers that carry a random nonce, and the system prompt says instructions inside it are ignored. The model has no tools. The reply must be exactly the JSON shape: extra keys (e.g. a tool request), missing keys, wrong types or non-JSON → `FAILED / INVALID_OUTPUT`. If the line around an excerpt reads like an instruction ("Ignore previous instructions…", "忽略以上…"), the fact is `SUSPICIOUS_EXCERPT`. This holds even when the model quotes only part of that line; a test caught exactly that case during development.

## Runs, limits and repeats

| Rule | Value / behaviour |
| --- | --- |
| Who starts a run | Only `POST …/extractions` with a fresh idempotency key (one click). Page loads, refreshes and polling only read |
| Input | Read by the server: the version's stored text, its supplemented version (context) and its request snapshot. The body may only contain `idempotencyKey` and `rerun`. Any other field (`rawText`, `versionId`, item ids …) → 422 |
| Input length | ≤ 30,000 characters (context ≤ 20,000). Longer → refused, nothing sent (never silently cut) |
| Output | ≤ 4,000 tokens; a truncated reply → `FAILED / OUTPUT_TRUNCATED` |
| Timeout | 60 s → `FAILED / TIMEOUT`, **not retried** (the provider may still have processed and billed it) |
| Retry | At most 1 retry, only for errors where nothing was produced (connection, 429, 5xx) |
| Same key again | Replays the stored run; no call |
| Click while running | `409 IN_PROGRESS` with the running row; no call |
| Already extracted (same mode, model, prompt) | `409 ALREADY_EXTRACTED`; running again needs `rerun: true` and a confirmation in the UI |
| Cap | 3 LIVE runs per version per 24 h (MOCK: 20) → `429` |
| Crash while running | Shown as "Interrupted — outcome unknown". Closed as `FAILED / INTERRUPTED` before the next run; never retried automatically |
| New version saved | Runs belong to a version id and its hash. A newer version starts with no extraction; the panel says which version it covers |

Each run stores: mode (`LIVE` / `MOCK`), provider, model, prompt version (`quote-extract-2026-10-24.1`), result schema version, input hash, request revision of the snapshot, context version, attempts, token usage when reported, start / finish time, status, error, raw output and checked result. Finished runs are immutable (trigger); nothing is deleted.

## Configuration and secrets

`src/server/extraction/model.ts`, read from the environment per call:

| State | When |
| --- | --- |
| `NOT_CONFIGURED` | `AI_PROVIDER`, `AI_MODEL` or `AI_API_KEY` empty (current state of `.env.local`), **or** a provider with no adapter. **No live adapter exists yet** |
| `READY · MOCK` | `AI_PROVIDER=mock` (development only). Canned outputs for the three SYNTHETIC demo quotes (zh, en and — since 3 Nov — the revised sample-order quote `supplier-quote-revised.synthetic.md` for the MOCK demo flow; `samples/synthetic/mock-model-output-*.synthetic.json`, matched by text hash). Any other text → `FAILED / MOCK_NO_FIXTURE`. Banner on the page: "MOCK MODE — … not an AI result" |
| `READY · LIVE` | Only after an adapter for an approved provider is added |

The page and the API only report variable **names**. The key never reaches the browser, logs or Git.

## API

| Method / path | Result |
| --- | --- |
| `GET /api/procurements/:id/quotes/:seriesId/versions/:versionId/extractions` | `{ config, version, runs, reviews, supplierRefs, limits, budget, costs }` (read-only; `budget` = overall LIVE budget status, `costs` = ledger rows per run) |
| `POST …/extractions` `{ idempotencyKey, rerun? }` | `201` finished run (`ok:false` when FAILED) · `200 REPLAYED` · `409 IN_PROGRESS / ALREADY_EXTRACTED` · `429 LIMIT_REACHED / BUDGET_EXHAUSTED` · `503 NOT_CONFIGURED / BUDGET_NOT_CONFIGURED / BUDGET_UNAVAILABLE` · `422` · `404` |
| `POST …/extractions/:extractionId/reviews` `{ idempotencyKey, fieldPath, action, valueText?, requestItemId?, basedOnReviewId }` | `201` · `200 REPLAYED` · `409 REVIEW_CONFLICT` (someone reviewed that field since) · `422` · `404` |

Actions: `CONFIRM` (only SUPPORTED values), `REJECT`, `CORRECT` (the user's own one-line value, stored as the user's statement), `MATCH_ITEM`, `NO_MATCH`. Every route checks access through `src/server/access/policy.ts`. Today that allows only the local developer (no login), and object-level rules plug in there on 28 Oct. No public or unauthenticated AI endpoint exists. Production builds return 404.

## Supplier quote number (design §2.3)

`quote_version_supplier_refs`, append-only. When a run finishes, each SUPPORTED number becomes an `AI_CANDIDATE` with its excerpt (a trigger checks the excerpt occurs in that version's text). Confirming a candidate writes `USER_CONFIRMED`, correcting writes `USER_ENTERED`, and rejecting a confirmed value writes `USER_CLEARED`. Candidates never count as the value. An old quote name (e.g. `[SYNTHETIC / DEMO] QT-DEMO-2026-118 (中文)`) was **not** turned into a number. Entering a number in the quote composer at save time is not built yet.

## Tests

`tests/numbers.test.ts` (22, value checks) and `tests/budget.test.ts` (20, budget incl. a 12-thread race on one SQLite file) were added 25 Oct, plus a regression test in `tests/extraction.test.ts` (now 38): with v1, v2, v3 saved, a supplement explicitly linked to v1 gets **v1** as context (prompt, run row, `ONLY_IN_CONTEXT`), not the latest version. `tests/extraction.test.ts` uses a synthetic mixed Chinese / English sample (`samples/synthetic/supplier-quote-mixed-fees.synthetic.md`) with planted problems: wrong total, freight "to be advised", insurance included, bank fee not included, duties without amount, two similar items, an injected instruction. Expected values are written by hand, not taken from model output. Results: `docs/setup-status.md`.

## What a real model still needs

**Found 24 Oct, fixed 25 Oct (mock-tested only):**

- ~~Value-in-excerpt check has no number boundaries~~ → "Value checks" above.
- ~~No overall API budget control~~ → "API budget" above. It is a mechanism with test prices (ISO test currency `XTS`); no real price, limit or currency is configured.

**Still needed for the first real call:** the owner's choice of provider, model, billing currency and approved spend; real prices for that model; the adapter must pass the 4,000-token output cap to the provider, report input / output usage, and set `notSent` only when the request provably never left this machine; check that the provider's billing items are covered by the bound (e.g. cached-input or reasoning tokens counted inside the output cap) and that its tokenizer is byte-level (else raise the input bound).

**Still needs human or real-model sample evaluation (code does not check meaning):** whether an excerpt belongs to the right field or item (a value from another line or item still counts as SUPPORTED if it appears in the excerpt); negation and conditions ("not included", "optional", "if …") behind INTERPRETED fields (payer, payee, included, stated as, basis); whether a fee is optional or conditional; which of several matching places is meant (only the first is shown); and translation or paraphrase errors (the value must be copied verbatim, so a translated value is refused rather than checked).

1. Owner decision: provider, model, billing currency, and a spending limit inside the S$100 cap (S$10 initial is only a suggestion and is **not** approved). Daily / total call limits.
2. One small adapter in `LIVE_ADAPTERS` (HTTP call, map 429/5xx to retryable, report token usage and truncation, pass the output cap, `notSent` only when provable), plus its unit tests with a stubbed HTTP layer.
3. The key in `.env.local` (Git-ignored), never printed; the `AI_BUDGET_*` / `AI_PRICE_*` values filled in by the owner from the provider's published price list.
4. Real acceptance: run on the two SYNTHETIC quotes and the mixed sample, then have a person review the outputs against the hand-written expectations. Record the cost per run (the run's ledger rows) and compare the local estimate with the provider's usage page.
