# Real-model extraction acceptance — 25 Oct 2026

> Model: Anthropic **`claude-sonnet-5-5`** (Claude API, direct), via `src/server/extraction/anthropic.ts`. Cases and expectations (written before any call): `samples/synthetic/live-acceptance/`. Raw results: `data/live-acceptance/*.json` (Git-ignored). Times UTC, 25 Oct 2026, ~11:47–11:48.
> **Owner acceptance (25 Oct 2026): passed** — the five-step manual check of the real-model results and the comparison of the local estimate with the Anthropic Console usage page were confirmed by the owner. A successful API call is still not a correct extraction; every value stays *pending review* until a person confirms it.
>
> | Item | Status |
> | --- | --- |
> | Live model connection and the five SYNTHETIC cases | **Owner-confirmed** |
> | Same run key repeated (replay, no second call); restart persistence | **Automated checks passed** |
> | Concurrency, limits, timeouts, refusal, invalid output, unknown cost | **Mock / stub tests only** |
> | Cost | 5 real calls; **US$0.069710 local estimate** from reported usage. The owner compared it with the Anthropic usage page and confirmed; it remains a local estimate, not the official bill |

## Calls, usage, cost

| Case | Run | Status | Input / output tokens | Reserved (USD) | Settled estimate (USD) | Provider request |
| --- | --- | --- | --- | --- | --- | --- |
| LA-1 | `qx_c55ff4b7…` | SUCCEEDED | 1,889 / 1,117 | 0.049135 | 0.014948 | `req_…` |
| LA-2 | `qx_4f23e399…` | INCOMPLETE | 1,853 / 846 | 0.049049 | 0.012166 | `req_…` |
| LA-3 | `qx_a802f268…` | SUCCEEDED | 1,935 / 1,315 | 0.049247 | 0.017020 | `req_…` |
| LA-4 | `qx_e016bfe8…` | SUCCEEDED | 1,986 / 280 | 0.049371 | 0.006772 | `req_…` |
| LA-5 | `qx_ac0a5762…` | INCOMPLETE | 1,802 / 1,520 | 0.048926 | 0.018804 | `req_…` |
| **Total** | 5 calls, 1 attempt each, 0 retries | | 9,465 / 5,078 | — | **0.069710** | |

- Settlement check (LA-1): 1,889 × $2/M + 1,117 × $10/M = $0.003778 + $0.011170 = **$0.014948** — equals the ledger. The free token count for LA-1 matched the billed input exactly (1,889).
- Ledger: 5 rows, all `SETTLED`; **0 UNKNOWN, 0 pending, 0 released**. Budget after the run (and again after a restart): today 5 / 20 calls, US$0.069710 of US$1 used; total 5 / 100, US$0.069710 of US$5. Remaining: US$0.930290 today, US$4.930290 total.
- These are **local estimates** from reported usage at the configured prices, not the Anthropic bill. Compare with the Console usage page.
- Repeat of LA-1 with the same run key: `200 REPLAYED` in 18 ms; still 5 LIVE runs and 5 ledger rows (no second call).
- After a dev-server restart: all 5 runs, their rule versions (`value-check-2026-10-25.1`) and ledger rows read back unchanged (GET only).

## Per case vs `expected.md`

| Case | Matches expectations | Details |
| --- | --- | --- |
| LA-1 normal | **Yes** | Number `LA-001` (AI candidate), date, USD, 200 pcs, USD 4.10, total 820.00, `TOTAL_MATCHES_ITEMS`, FOB Ningbo, lead time, payment terms — all SUPPORTED. Item match PROPOSED to the only line. Freight: amount **NOT_STATED** (not 0), TO_BE_CONFIRMED, payer BUYER, not included. Extra (not wrong): a GOODS fee line repeating the total; its inclusion is not stated, so the cost overview counts it as unknown, not added twice |
| LA-2 numbers | **Yes** (status INCOMPLETE for an unrelated reason) | Quantity **500** (not 1500), unit price **USD 3.20** (not 13.20), total 1,600.00, arithmetic matches, FOB Xiamen. The one failed check: a fee *description* paraphrased by the model ("…unit price") was not in its excerpt → `VALUE_NOT_IN_EXCERPT`, correctly refused. Item name kept "Model BT-1500" as written; `BT-1500` was not used as a quantity or quote number |
| LA-3 multi-item | **Yes** (with the documented limit) | A: lunch box 300 sets @ 5.50; B: cutlery 600 sets @ 1.20; total 2,370.00 matches. Matches: A → lunch-box line, B → cutlery line (both PROPOSED). Packaging USD 0.30, PER_UNIT, NOT_INCLUDED. **Limit:** the fee model has no item link, so "for Item A only" is visible only in the excerpt — a person must read it; per-unit fees are not summed |
| LA-4 supplement → v1 | **Yes** | Context sent = **v1** (`qv_681eb539…`), not v2. Lead time **35 days after deposit** SUPPORTED; number `LA-004` (from the supplement's own text). Everything else NOT_STATED; nothing from v2 (0.85 / 850.00 / FOB Ningbo / LA-004-R2) |
| LA-5 vague | **Yes** | No currency (bare `$`): unit price and total refused (`INVALID_VALUE`, value null), never assumed USD. Quantity 400. Freight TO_BE_CONFIRMED, amount NOT_STATED. Duty / GST: payer BUYER, not included, amount NOT_STATED. Payment terms "to be agreed after sample approval" is SUPPORTED **as verbatim text** — the person must treat it as not agreed. INCOMPLETE as expected |

Nothing became "confirmed by you" (all values show *Pending your review*); no review rows were written.

## Known limitations (recorded at acceptance)

- **Fee applies to which item is not linked:** a fee line has no item reference (LA-3 "for Item A only" is visible only in the excerpt).
- **Conditions not yet agreed:** text such as "to be agreed after sample approval" is SUPPORTED as verbatim text but means "not agreed" (LA-5).
- **Duplicate GOODS fee lines:** the model repeated the goods total as a fee line in three cases; counted as unknown in the cost overview, never added twice, but noisy for review.
- **Sample size:** five small SYNTHETIC cases, one run each — no accuracy claim for real quotes.

## Limits of this acceptance

- Five small synthetic cases, one run each — not a measure of accuracy on real quotes; no accuracy figure is claimed.
- Matching an excerpt proves the number is in the cited text, not that it belongs to the right item or fee (LA-3 shows where only a person can tell).
- The model added duplicate "GOODS" fee lines in three cases; harmless for the cost overview (counted as unknown), but noisy for a reviewer — prompt wording can be tuned later (new prompt version, re-run only with consent).
- Concurrency, limits, timeouts, refusals, invalid output and unknown costs were tested with stubs and fakes (`tests/anthropic.test.ts`, `tests/budget.test.ts`), not with paid calls.
- UI seen in a normal Edge window (8/8 read-only checks): LIVE label with the "a successful call is not a correct extraction" reminder, budget block, per-attempt cost. The budget table needs horizontal scrolling at 1366 px (later UI polish).
