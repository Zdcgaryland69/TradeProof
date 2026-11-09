# Real-model acceptance — expected results (written 25 Oct 2026, before any real call)

> SYNTHETIC / DEMO cases in this folder. Expectations are written by a person from the text, not taken from model output; a model's own statements are never the evidence. "Code check" = what TradeProof's server checks must show; "person" = what only a human can judge. A successful API call is not a correct extraction.

Legend: **S** = check `SUPPORTED` (source excerpt found, value check passed) · **NS** = `NOT_STATED` · **✗** = any non-supported check (value null). "Value must not be" lists the trap.

## LA-1 — normal complete quote (1 request line: bottle 500 ml, 200 pcs)

| Field | Expected | Code check | Value must not be |
| --- | --- | --- | --- |
| supplier quote number | `LA-001` | S, AI candidate only (not confirmed) | — |
| quote date | `2026-10-20` | S | — |
| currency | USD | S | — |
| item quantity / unit | `200` / `pcs` | S / S | `500` (the capacity) |
| unit price | USD `4.10` | S | — |
| total | USD `820.00` | S; arithmetic `TOTAL_MATCHES_ITEMS` (200 × 4.10 = 820.00) | — |
| incoterm / lead time / payment | `FOB Ningbo` / `30 days after deposit` / `30% deposit, 70% before shipment` | S | — |
| item match | the one request line | `PROPOSED` (still needs the user) | — |
| freight fee | kind FREIGHT, not included, payer BUYER; **amount unknown** | amount NS or ✗ (never 0); statedAs not FIRM | an invented amount |
| run status | SUCCEEDED expected | — | — |

## LA-2 — 500 vs 1500, unit price vs other price (1 line: bottle 500 ml, 500 pcs)

| Field | Expected | Code check | Value must not be |
| --- | --- | --- | --- |
| quantity | `500` | S (excerpt with "500 pcs") | `1500` (MOQ, not ordered); `500` cited only from "500 ml" or "BT-1500" would be ✗ by code |
| unit price | USD `3.20` | S | USD `13.20` (gift-box version, not ordered) |
| total | USD `1,600.00` | S; arithmetic matches (500 × 3.20) | — |
| number / date / incoterm | `LA-002` / `2026-10-21` / `FOB Xiamen` | S | `BT-1500` as quote number |
| person | if the model picks 1500 or 13.20 *with an excerpt that contains it*, code still says S → this is exactly the "number in excerpt ≠ right field" limit; the person must catch it | | |

## LA-3 — two items, fee that belongs to one item (2 lines: lunch box 300 sets, cutlery 600 sets)

| Field | Expected | Code check | Value must not be |
| --- | --- | --- | --- |
| items | 2: A lunch box `300` sets @ USD `5.50`; B cutlery `600` sets @ USD `1.20` | S for each | A with 600 or 1.20; B with 300 or 5.50 |
| total | USD `2,370.00` | S; arithmetic matches (1,650 + 720) | — |
| item match | A → lunch box line, B → cutlery line | each `PROPOSED` (or `AMBIGUOUS` / `UNMATCHED` — acceptable, never auto-confirmed) | A → cutlery or B → lunch box |
| packaging fee | USD `0.30` **per set**, not included, for item A only | amount S, basis PER_UNIT; not added to the cost overview (per-unit fees stay unknown) | lump sum; applied to item B |
| person | whether 0.30 is tied to A (the fee model has no item link — the person reads it) | | |

## LA-4 — supplement linked to v1 while v2 exists (extract v3 = supplement to v1)

| Field | Expected | Code check | Value must not be |
| --- | --- | --- | --- |
| context sent | v1 (LA-004, USD 0.90, FOB Shanghai, 25 days) | run `contextVersionId` = v1 | v2 (LA-004-R2) |
| lead time | `35 days after deposit` | S | `25 days…` (v1), `20 days…` (v2) |
| quantity, prices, total, incoterm | not stated in the supplement | NS, or `ONLY_IN_CONTEXT` if quoted from v1 | anything from v2 (USD 0.85 / 850.00 / FOB Ningbo) — would be `NOT_IN_TEXT` |
| supplier quote number | `LA-004` may be reported (it is in the supplement text) | S if reported | `LA-004-R2` |
| result | a SUPPLEMENT: comparator adapter returns nothing; silence is not cancellation | — | — |

## LA-5 — missing or vague fees and terms (1 line: mug 350 ml, 400 pcs)

| Field | Expected | Code check | Value must not be |
| --- | --- | --- | --- |
| currency | none named (bare `$`) | currency NS or ✗ | USD accepted as a fact |
| unit price / total | `2.80` / `1,120.00` written, currency unknown | ✗ (excerpt names no currency) or NS | SUPPORTED with a currency |
| quantity | `400` | S | — |
| freight | to be advised: amount unknown | amount NS/✗; statedAs TO_BE_CONFIRMED (never FIRM) | 0 or an invented amount |
| duty and GST | payer BUYER; amount unknown | amount NS/✗ | a guessed rate or amount |
| payment terms | `to be agreed after sample approval` — undetermined | may be S as verbatim text; **person** must treat it as "not agreed", not as terms | 30/70 or any invented split |
| run status | INCOMPLETE likely (currency) — acceptable | — | — |

## Every case

- Run shows LIVE · anthropic / claude-sonnet-5-5 (not MOCK); usage reported; one ledger row per attempt: SETTLED from usage, or UNKNOWN when the cost cannot be priced — never RELEASED after a sent request.
- No value without an excerpt from this version's text; unknown amounts are never 0; nothing becomes "confirmed by you" without a click.
- Repeating the same run key replays: no second call, no second ledger row.
- An honest failure (invalid JSON, truncation, refusal, timeout) is recorded as such and **not retried** to get a nicer answer.
