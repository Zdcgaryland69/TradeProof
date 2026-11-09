# Approval condition snapshot and version binding — design (29 Oct 2026, revision 3 = as built)

> **State: built 29 Oct (schema v14); owner's five manual steps passed (confirmed 2026-10-29 SGT). Concurrency, tamper refusals and the payment state machine remain automated / MOCK only; real approval → Sandbox payment, access control and the A–D grade not done.** Revision 2 followed the owner's review of revision 1 (`ebc2ad1`). The owner then confirmed the four product decisions (§11) and six more boundaries, which revision 3 adds (§15, "as built"). Where §15 differs from earlier sections, §15 applies. MOCK PayPal only; no real Sandbox payment for approvals has been made or enabled; access control and the A–D grade are still **not done**.
> Scope: an in-app **human approval decision** on the latest complete conditions of one quote series, stored as an immutable snapshot, and the rule that a later Sandbox payment reads its amount only from that snapshot.
> Not in scope: PayPal buyer authorisation (the buyer's approval of the PayPal order, a separate step), staged payments, escrow, dual approval, refunds, tax / duty calculation, currency conversion, the A–D readiness grade (deferred, §10.4).
> **Until access control exists, approval is a local development demo.** The approver is recorded as "local developer (not signed in)". No authenticated approver, no separation of duties and no two-person approval is claimed.

## 0. What the snapshot must answer

| Question | Where the answer comes from (§) |
| --- | --- |
| Which procurement, which revision, which quote version am I approving? | Binding (§2): request id + `PR-` ref, request revision, quote series `QS-` + **latest** version (+ explicit base for a supplement) + text hashes, extraction runs, rules versions |
| What are the goods, quantities, currency, fees, payment terms and payee? | Terms (§3, §4): only from the bound version(s)' extraction **as reviewed by the user**; payee = fixed Sandbox test merchant |
| What has been checked, and what is still unknown? | Gate result (§3): BLOCK / CONFIRM / INFO list, origin of every value (confirmed / corrected / model-only) |
| How much is to be paid now, and why? | Money (§4): the stated USD quote total, re-added from reviewed lines, under the one payment scenario of v1 |
| If the basis changes after approval, how is the old approval stopped? | Validity (§5): append-only facts since the approval, checked at every payment step; invalid is terminal |

## 1. Baseline checked on 29 Oct (read-only)

| Item | Expected | Found |
| --- | --- | --- |
| Git | `main` at `b577cbb`, clean | Same (revision 1 of this design then committed as `ebc2ad1`) |
| DB | schema v13, integrity ok, FK ok | `user_version` 13, `integrity_check` ok, `foreign_key_check` 0 rows |
| Extraction runs | LIVE 5, MOCK 16, none running | LIVE 5 (3 SUCCEEDED, 2 INCOMPLETE), MOCK 16 (15 SUCCEEDED, 1 FAILED), 0 RUNNING |
| Budget ledger | 5 rows, US$0.069710 settled | 5 SETTLED, 69 710 micro-USD |
| Sandbox payment | 1 PAID USD 1.00, 10 events | 1 record PAID, `amount_minor` 100 USD; 10 events |
| Server | stopped, port 3000 free | No TradeProof node process; port 3000 free |
| Free memory | — | ≈ 2.8 GB free of 16 GB |
| Configuration | presence only | PayPal environment / client id / secret / expected payee: configured. AI provider / model / key: configured. Values not read |

Difference: the read-only open left `-wal` (0 bytes) / `-shm` next to the DB (known SQLite behaviour; harmless; not deleted by hand).

## 2. Binding — what one approval is bound to

All values are **read on the server from stored rows**, at preview time and again inside the approval transaction. The browser sends ids, the preview digest and the confirmation keys only (§6).

| Bound to | Exists today | Source | New |
| --- | --- | --- | --- |
| Request id, `PR-` ref | yes | `procurement_requests.id` | — |
| Request revision the quote version(s) were saved against | yes | `quote_versions.request_revision` + `request_snapshot` | — |
| Request revision current at approval | yes | `procurement_requests.revision` | stored |
| **Approval-relevant request fingerprint** | no | canonical hash of the request record **without** `title`, timestamps, `source`: items with ids, name, qty, unit, material, specification, customization, notes; budget; ship from / to; dates; payment terms; additional requirements; buyer type / person | `requestFingerprint()` (pure) |
| Quote series, **latest** version id + number + content kind | yes | `quote_versions` | the bound version must be the latest (§3.1 B4) |
| SUPPLEMENT: its explicit base version | yes | `supplements_version_id` | composition rules §2.2 |
| Text hashes (bound version and base), recomputed now | yes | `raw_text_sha256` vs `sha256(raw_text)` | — |
| Extraction run per version: id, mode LIVE/MOCK, provider, model, prompt / schema version, status, `checkRules` | yes | `quote_extraction_runs`; `runRefusal()` | — |
| Reviews of those runs | yes | `quote_extraction_reviews` | **digest of all review ids** at approval |
| Item pairing (user decision) | yes | `MATCH_ITEM` / `NO_MATCH` → `Comparison.pairings` | — |
| Comparison, recomputed on the server | yes (on demand) | `ComparisonService.compare()` → `compareExtraction()`; `COMPARATOR_VERSION` | re-run inside the approval service, never read from a page |
| Supplier replies, buyer statements, updated-quote links of the series | yes | `ReplyService.buyerStatements()`, `updatedQuoteStatus()`, `supplier_reply_quote_links` | **digest of the statement set** (answer ids, kinds, quote-update flags, links) |
| Unresolved items | yes | `OPEN` rows, open fees, `unresolvedInheritance`, open questions | listed in the snapshot |
| Fee payee per line | in extraction only | `fees[i].payee` (the comparator's `FeeView` has none) | read with the comparator's "latest review wins" helper (export `usedValue`, no re-implementation) |
| Payee | config | `PAYPAL_EXPECTED_PAYEE_MERCHANT_ID` | **SHA-256 fingerprint** + label "fixed Sandbox test merchant — not the supplier" |
| Rules | partly | `CURRENT_CHECK_RULES`, `COMPARATOR_VERSION`, `REPLY_RULES` | `APPROVAL_RULES = "approval-rules-2026-10-29.2"` (proposed) |

**Never used as a source:**
- reply text or buyer statements, even with numbers in the excerpt;
- supplier names, supplier quote numbers;
- payees named in the quote (for the PayPal payee);
- model values nobody reviewed;
- an older version once a newer one exists;
- the fact that someone opened the comparison page;
- anything the browser sends besides ids, digest and confirmation keys.

### 2.1 When the request was updated after the quote was saved

The comparison basis is the request **as saved with the quote version**. It is never swapped for the current one.

- **Title only** changed (relevant fingerprints equal) → INFO; approval allowed.
- **Anything relevant** changed → BLOCK `REQUEST_CHANGED_SINCE_QUOTE`. Path to a consistent basis:
  1. check the current request is what is to be bought;
  2. save the supplier's quote text again as a **new version** of the same series (same text is allowed; it gets the current request snapshot), or save the supplier's new quote;
  3. run an extraction on it (MOCK replay in tests; a LIVE run is a paid call and needs explicit consent);
  4. review the critical fields (§3);
  5. preview again.
- The old version, run and reviews stay unchanged. Nothing is copied over, because reviews belong to their run.

### 2.2 Which version is approvable: the latest complete conditions of the series (v1)

- **Only the latest version of the series is approvable.** Once a newer version exists, an older one cannot be approved — no tick overrides this (B4).
- The latest version must form **complete conditions**, either:
  - **FULL_QUOTE:** the version alone; or
  - **SUPPLEMENT:** the supplement + **its explicitly linked base**, nothing else. The base must be a FULL_QUOTE, and there must be no FULL_QUOTE saved between base and supplement (otherwise the supplement skips a newer full quote → BLOCK `SUPPLEMENT_SKIPS_NEWER_FULL`). A supplement of a supplement → BLOCK `SUPPLEMENT_CHAIN` (not supported in v1).
- **Composition of a supplement's conditions** (per field: currency, total, items, trade term, lead time, payment terms, fee lines):

  | Comparator status | Value used | Source recorded in the snapshot |
  | --- | --- | --- |
  | `STATED_IN_SUPPLEMENT` / `CHANGED_BY_SUPPLEMENT` | the supplement's reviewed value | supplement version n, its run, review id |
  | `INHERITED` | the base's reviewed value | base version m, its run, review id |
  | `UNRESOLVED` | none | BLOCK B5 |

  - Both runs must pass `runRefusal()` on current rules and both versions' request snapshots must match the current relevant fingerprint.
  - Critical fields need a review in the run they come from.
  - Silence in a supplement keeps the base value. It never cancels it, and nothing is merged beyond this table.
- **If the latest version cannot form valid complete conditions, approval is blocked.** It never falls back to an older version.
  - If the supplier says an older version still stands, the path is to save that text again as a new latest version. The choice is then an explicit record, not a tick.

## 3. Approval gate (revision 2)

Result levels:
- **BLOCK**: approval impossible.
- **CONFIRM**: allowed only after the user confirms this exact item. Used **only where the quote provides evidence**; a confirmation never replaces missing supplier evidence.
- **INFO**: always shown, no action.

A blocking item cannot be offset by passes.

"Reviewed" = the field's latest review in its run is CONFIRM or CORRECT.

**Critical fields:**
- item match, quantity, unit, unit price;
- currency, stated total, payment terms;
- key attributes (§3.2);
- per fee line: kind, inclusion and, for NOT_INCLUDED lines, payee.

### 3.1 Basis

| Code | Condition | Result | User's path |
| --- | --- | --- | --- |
| B1 `TEXT_HASH_MISMATCH` | stored text hash ≠ recomputed (bound version or base) | BLOCK | None in the app; investigate (data integrity) |
| B2 `RUN_NOT_USABLE` | `runRefusal()` ≠ null: other version, hash, snapshot revision, not finished, **older rules**, content kind, context | BLOCK | Extraction on current rules, review, preview again |
| B3 `REQUEST_CHANGED_SINCE_QUOTE` | current relevant fingerprint ≠ the version's (or base's) snapshot fingerprint | BLOCK | §2.1 |
| B3i `REQUEST_TITLE_ONLY` | revision differs, fingerprint equal | INFO | — |
| B4 `NOT_LATEST_VERSION` | the version is not the latest of its series | **BLOCK** (no override) | Approve the latest version; or re-save the intended text as the new latest (§2.2) |
| B5 `SUPPLEMENT_INCOMPLETE` | supplement without a usable base run, `unresolvedInheritance` not empty, `SUPPLEMENT_SKIPS_NEWER_FULL`, `SUPPLEMENT_CHAIN` | BLOCK | Run / review the base extraction, or get a full quote |
| B6i `MOCK_RUN` | a bound run is MOCK | INFO "MOCK — canned test output, not an AI result" | — (allowed for SYNTHETIC tests; every value used is still the user's review) |
| B7 | "compared" flag or page visit | never evidence | The service always recomputes; no such flag exists |

### 3.2 Items, quantities and key attributes

**Key attribute** = a field the buyer explicitly required on the request line: `material`, `specification`, `customization` (→ logo), when not empty. The comparator already produces a row for exactly these.

**Descriptive** = everything else: item notes, extra quote wording (colour, packaging description) with no matching request field, and request-level `additionalRequirements`. Code does not check these. They are shown side by side as INFO.

Limitation: a requirement written only in free-text notes or additional requirements is **not** detected as missing. Key requirements belong in the item's material / specification / customization fields.

| Code | Condition | Result | User's path |
| --- | --- | --- | --- |
| I1 `PAIRING_NOT_CONFIRMED` | a request line or quote item PROPOSED / NEEDS_CHOICE / CONFLICT | BLOCK | Confirm the match in review |
| I2 `REQUEST_LINE_NOT_QUOTED` | request line not quoted, or user chose "no match" | BLOCK | Remove the line from the request (→ §2.1) or get a revised quote |
| I3 `EXTRA_QUOTE_ITEM` | quote item not on the request (it is inside the total) | BLOCK | Add it to the request (→ §2.1) or get a revised quote without it |
| I4 `QTY_NOT_REVIEWED` / `QTY_DIFFERS` / `UNIT_DIFFERS` | quantity / unit pending, rejected, unreadable or ≠ request | BLOCK | Review; if the supplier really quotes another quantity: change the request (→ §2.1) or get a revised quote |
| I5 `PRICE_NOT_REVIEWED` | unit price pending, rejected, unreadable, other currency | BLOCK | Review |
| I6 `KEY_ATTRIBUTE_NOT_QUOTED` | key attribute with **no supplier basis**: not stated in the quote, excerpt not found, rejected, or the quote states only part of it (e.g. logo method without the required colours) | **BLOCK** (no tick) | Ask the supplier → updated quote that states it; or, if the buyer drops the requirement, edit the request (→ §2.1) |
| I7 `KEY_ATTRIBUTE_DIFFERS` | material / logo DIFFERENT | BLOCK | Accept the supplier's value by editing the request (→ §2.1), or get a revised quote |
| I8 `KEY_ATTRIBUTE_NOT_REVIEWED` | supplier basis exists (excerpt found) but the value is not reviewed | BLOCK | Review |
| I9c `KEY_ATTRIBUTE_BY_EYE` | supplier basis exists and is reviewed, but code cannot judge it: specification (always free text), or request / quote wording not recognised | CONFIRM "I compared request and quote text for <line, field> and the quote meets the requirement" | — |
| I10i `DESCRIPTIVE_SIDE_BY_SIDE` | descriptive fields (above) | INFO | — |

### 3.3 Money, currency, arithmetic, budget

| Code | Condition | Result | User's path |
| --- | --- | --- | --- |
| M1 `CURRENCY_NOT_REVIEWED` / `SEVERAL_CURRENCIES` | currency pending / rejected, or more than one | BLOCK | Review; or get a single-currency quote |
| M2 `CURRENCY_NOT_PAYABLE` | not supported by `money.ts` for Sandbox (today USD only) | BLOCK | USD quote. **No conversion, never a guessed currency** |
| M3 `TOTAL_NOT_REVIEWED` / `TOTAL_NOT_STATED` | stated total pending, rejected, unreadable or absent | BLOCK | Review; or get a quote with a stated total |
| M4 `TOTAL_DIFFERS_FROM_LINES` / `CANNOT_CHECK_TOTAL` | stated total ≠ Σ(reviewed qty × reviewed unit price), or not checkable | BLOCK | Correct a misread value (the arithmetic must then agree; a correction never overrides it) or get a revised quote |
| M5c `USES_CORRECTION` | a critical value is the user's correction of a found excerpt and the arithmetic agrees | CONFIRM (original value + excerpt shown) | — |
| M6 `ABOVE_SANDBOX_CEILING` | amount > technical ceiling (proposal USD 100.00, a code constant) | BLOCK | Smaller SYNTHETIC quote; never scaled down |
| M7 `OVER_BUDGET` | total > request budget | **BLOCK** (recommended, §11) | Raise the budget in the request (new revision → §2.1: re-save the quote, re-extract, re-review) |
| M8 `BUDGET_NOT_COMPARABLE` | budget in another currency | **BLOCK** (follows M7) | Set the budget in the quote currency (no conversion) |
| M9i `NO_BUDGET` | no budget set | INFO "no budget limit recorded" | — |

### 3.4 Payment terms, lead time, trade term

| Code | Condition | Result | User's path |
| --- | --- | --- | --- |
| P1 `TERMS_NOT_SETTLED` | pending / rejected / not stated / "to be agreed" / not parseable | BLOCK | Clarify → updated quote |
| P2 `STAGED_PAYMENT` | parsed deposit < 100 % (30 / 70, 50 / 50) | BLOCK in v1 | Revised quote stating one full payment; staged payments are not planned |
| P3 | parsed 100 % (in advance / before shipment), reviewed | ALLOW | — |
| L1 `LEAD_TIME_TOO_LATE` | misses the required date | BLOCK | Change the required date (→ §2.1) or revised quote |
| L1c | start unclear / approximate (stated in the quote) | CONFIRM | — |
| L1i | not stated, and no required date in the request | INFO | — |
| L1b | not stated, and the request has a required date | BLOCK (no supplier basis for a buyer requirement) | Updated quote |
| L2 `INCOTERM_DIFFERS` | trade term ≠ request | BLOCK | Edit request (→ §2.1) or revised quote |
| L2b | request names a trade term, quote states none | BLOCK (no supplier basis) | Updated quote |
| L2c | quote wording not recognised (excerpt found) | CONFIRM | — |
| L2i | neither side names one | INFO "freight and risk transfer not stated" | — |

### 3.5 Fee lines

| Code | Condition | Result | Shown under (§4.1) |
| --- | --- | --- | --- |
| F1 `FEE_SCOPE_NOT_REVIEWED` | kind or inclusion not reviewed, or NOT_INCLUDED with payee not reviewed | BLOCK | — |
| F2 | INCLUDED (reviewed) | ALLOW | "Included in the stated total" (not added again) |
| F3 | NOT_APPLICABLE (reviewed) | ALLOW | listed |
| F4c `GOODS_REPEAT_EXACT` | GOODS line equal to the total / an item price / a line subtotal | CONFIRM "repeat of a goods amount — not added" | — |
| F4 `GOODS_REPEAT_UNCLEAR` | GOODS line with another amount | BLOCK | — |
| F5 `SUPPLIER_EXTRA_OUTSIDE_TOTAL` | NOT_INCLUDED, payee SUPPLIER (amount known or not) | BLOCK in v1 | — (path: revised quote whose total includes it) |
| F6 `FEE_PAYEE_UNKNOWN` | NOT_INCLUDED, payee not stated | BLOCK | — (path: review the payee if the quote states it; a user correction → M5c; else ask the supplier) |
| F7c `OUTSIDE_THIS_PAYMENT` | NOT_INCLUDED, payee not the supplier (carrier, government, broker, insurer, payment provider, other) | CONFIRM | "Excluded", "Unknown" or "Unverified" per §4.1 |
| F8i | payer SUPPLIER | INFO | listed |

### 3.6 Supplier replies and buyer statements

| Code | Condition | Result | User's path |
| --- | --- | --- | --- |
| R1 `NEW_TERMS_WITHOUT_QUOTE` | a statement in this series is PROPOSES_NEW or "updated quote needed", and the bound version (or its base) is **not** linked as that reply's updated quote | BLOCK | Save the updated quote as a new version → extract → review → approve it. If the bound version **is** that update: record the reply → version link (existing action), preview again |
| R2c `NEW_TERMS_LINKED` | same, linked to the bound version | CONFIRM "this version reflects reply N" (statement shown beside the reviewed value) | — |
| R3c `STATEMENT_UNCLEAR` | UNCLEAR / manual review | CONFIRM | — |
| R4 `READINGS_CONFLICT` | newest buyer readings of different replies disagree on a critical field | BLOCK | Record a resolving reading |
| R5i | CONFIRMS_ORIGINAL | INFO "your reading of reply N — not the supplier's agreement; values unchanged" | — |
| R6i | statement recorded on an earlier basis | INFO with reasons | — |

A buyer statement never changes a value or amount and never turns a result into ALLOW. It can only add BLOCK or CONFIRM.

### 3.7 Payee, environment, earlier payments

| Code | Condition | Result |
| --- | --- | --- |
| Y1 `PAYEE_NOT_CONFIGURED` | PayPal Sandbox not configured | BLOCK (the snapshot must name a payee) |
| Y2i | always | INFO "Payee: fixed Sandbox test merchant. Not the supplier; demo only, no real money" |
| Y3i | always | INFO "Approval in TradeProof is not PayPal's buyer approval and not a payment authorisation; each payment step is a separate action" |
| X1 `PAYMENT_OUTCOME_OPEN` | an earlier payment of this request is CAPTURING / CAPTURE_UNKNOWN / CAPTURE_PENDING / NEEDS_REVIEW | BLOCK (until that outcome is known) |
| X2 `ALREADY_PAID` | an earlier payment of this request is PAID | BLOCK (a second payment is not supported in v1) |

## 4. Money

### 4.1 Figures shown separately (never merged)

| Figure | Definition | Unknown? |
| --- | --- | --- |
| **Goods subtotal** | Σ reviewed qty × reviewed unit price over paired lines; one currency; integer minor units | Then M4 blocks |
| **This payment to the supplier** | v1: the **stated quote total**, equal to the goods subtotal; INCLUDED fees are inside it. Once, in full, to the fixed Sandbox payee | Never; otherwise blocked |
| **Not in this payment — excluded** | Fee lines the quote states as not included, payee not the supplier, kind / inclusion / payee **and amount reviewed**, stated as FIRM | — |
| **Not in this payment — unknown** | Such lines whose amount or payer is not stated | Shown as "amount unknown" / "payer unknown", **never 0** |
| **Not in this payment — unverified** | Such lines whose amount is stated but **not reviewed**, or stated as ESTIMATE / TO_BE_CONFIRMED | Shown with the quote's wording and "not verified by you" |
| **Landed cost** | **"This version does not calculate the full landed cost."** / 「本版本未计算完整到岸成本。」 | Always; no figure, no claim about taxes, duties or compliance |

No currency conversion, no sum across currencies, per-unit fees never multiplied automatically. Costs the quote doesn't mention at all (e.g. international freight under FOB) are not invented as lines. The landed-cost sentence covers them.

### 4.2 The one payment scenario of v1 (recommended, §11 Q1)

**Full payment of the stated USD quote total in one PayPal Sandbox payment.**

It applies when all of these hold:
- payment terms reviewed and read as 100 %;
- currency USD;
- total reviewed and equal to the reviewed lines;
- no supplier-payable charge outside the total;
- amount ≤ the technical ceiling.

No percentage base and no rounding are needed. The amount traces to one stated, reviewed figure that code re-adds.

**Samples.**
- The existing SYNTHETIC samples (30 / 70, 50 / 50) are **not changed**. They are used as they are as blocked cases (P2).
- New samples are added **only to cover the product scenarios**:
  - `samples/synthetic/approval-*.synthetic.md`, each headed "SYNTHETIC — fictional, for TradeProof tests";
  - small USD totals (e.g. USD 12.00), "100 % T/T before shipment";
  - plus hand-written SYNTHETIC model outputs for MOCK replay.

No reply free text is ever turned into an amount.

**Ceiling ≠ authorisation.**
- USD 100.00 is a proposed **technical upper limit**, not an approval or authorisation of automatic payment.
- Nothing pays by itself. Each payment step is a user action.
- Any real Sandbox call needs the owner's explicit go-ahead.
- The real Sandbox acceptance uses a **small, explicit SYNTHETIC case** (Example A, USD 12.00), not the ceiling.

## 5. Snapshot, states, validity

### 5.1 Minimal data (next free schema version when written, today v14; nothing reserved)

**`approvals`**: one immutable row per approval (UPDATE / DELETE refused by triggers). It holds:
- id `ap_<uuid>`, request id, series id, version id, base version id;
- run id, base run id;
- request revision at approval, quote snapshot revision(s), relevant request fingerprint;
- text hashes, latest version number at approval;
- review-ids digest, statements digest, payee fingerprint;
- rules versions;
- payment amount minor + currency;
- `snapshot_json` (canonical) + `preview_digest`;
- confirmation keys;
- approver kind / id / authenticated flag;
- idempotency key (unique) + payload fingerprint, created at.

**`approval_events`**: append-only.
- id, approval id, kind `INVALIDATED` | `REVOKED`, reason code, detail (codes and ids only), created at.
- The first one is terminal.

**`approval_payments`**: append-only.
- approval id, payment record id (unique), created at.

`sandbox_payment_records` is not rebuilt. An approval payment is an ordinary row:
- amount / currency from the snapshot;
- sku `TP-APPROVAL`;
- item name "TradeProof approval PR-… QS-… v<n> (Sandbox)", no quote text.

Preview: **not stored** (§6.1).

### 5.2 State transitions

```
PREVIEW (computed, not stored)
  BLOCKED ──(user fixes the cause; new data)──► new preview
  READY / READY_WITH_CONFIRMATIONS
     │ POST approve: authorise → recompute inside BEGIN IMMEDIATE → digest equal?
     │               confirmation keys equal? no ACTIVE approval? → insert   (else nothing stored)
     ▼
APPROVAL (immutable row)
  ACTIVE ──(any §5.3 fact since approval)──► INVALIDATED   terminal
  ACTIVE ──(user revokes, reason)──────────► REVOKED       terminal
  INVALIDATED / REVOKED ──► (never back) — a new preview + a NEW approval (new id) is the only way on
     │ ACTIVE only
     ▼
PAYMENT (existing record states)
  NEW → ORDER_CREATING → ORDER_CREATED → CAPTURING → PAID
                                       ↘ CAPTURE_UNKNOWN / CAPTURE_PENDING / NEEDS_REVIEW / FAILED
  validity checked at: create record · create order · capture (decision point) — boundaries in §5.4
```

- **History vs current validity.** The snapshot row never changes. Validity = no terminal event **and** §5.3 finds nothing. The first detection writes `INVALIDATED`, so the state is visible and sticky.
- **Payment truth is never erased** by invalidation or revocation. The page shows both facts, e.g. "Approval invalidated after payment (request revised) · Payment PAID USD 12.00, capture id …".

### 5.3 What invalidates, and why "edited, then reverted" stays invalid

Validity doesn't compare "approved state vs current state". It asks: **did any append-only record appear after the approval that changes the basis?** All the records below are immutable / append-only today, so a later revert adds a record and removes none.

| Change after approval | Effect | Event basis (append-only record) |
| --- | --- | --- |
| A request revision whose relevant fingerprint ≠ the approved one | **Invalidates** | every row of `procurement_request_revisions` with `revision` > stored revision is checked, **not only the latest**. Edit (r6, differs) then revert (r7, equal) → r6 exists → invalid. Every real change writes a revision in the same transaction (v8 rule) |
| Any new review on a bound run (even a re-confirm) | **Invalidates** | `quote_extraction_reviews` rows not in the stored review-ids digest |
| A newer quote version in the series | **Invalidates**; the old version can't be re-approved (B4) | `quote_versions.version_number` > stored latest number |
| A new or superseding buyer answer, a new reply → quote link in the series | **Invalidates** | `clarification_answers` / `supplier_reply_quote_links` rows not in the statements digest |
| Configured payee changed | **Invalidates** | payee fingerprint (config, checked at each step) |
| Approval / comparator / check rules version changed in code | **Invalidates** | stored versions |
| Version text hash no longer recomputes | **Invalidates** | B1 |
| Assignment of the approving approver revoked (after access control) | **Invalidates** | append-only grant / revoke rows (design §6.4) |
| User revokes | **Revoked** | `approval_events` |
| Request title only | No effect | fingerprint excludes title |
| New extraction run on a bound version (not bound) | No effect | bound run ids fixed |
| Clarification drafts, copying, translations, page visits, UI wording | No effect | not in the basis |
| Other requests / series | No effect | scoped by ids |

`INVALIDATED` is written the first time any check finds such a record: on approval view, payment creation, order or capture. Correctness doesn't depend on someone looking in between: the records stay.

### 5.4 Payment boundaries when the basis changes (no promise to undo a sent payment)

| Payment state when the approval becomes invalid / revoked | What TradeProof does | What it does not promise |
| --- | --- | --- |
| No payment record | Payment creation refused (`APPROVAL_INVALID`) | — |
| `NEW` (no PayPal call yet) | Order creation refused; the record stays `NEW` and is never used again | — |
| `ORDER_CREATING` (create request sent, or outcome unknown) | No create with a **new** request id. Reconcile may repeat the **same** PayPal-Request-Id to learn the order id (same logical create; no money moves). Once an order is known → capture refused | That PayPal did or did not create an order before the lookup |
| `ORDER_CREATED` (incl. buyer approved at PayPal) | Capture refused, event `CAPTURE_REFUSED_APPROVAL_INVALID`. The order is left uncaptured. TradeProof has no void call | Cancelling the PayPal order or an exact expiry time |
| `CAPTURING` (capture committed and sent) | **Cannot be stopped.** The outcome is recorded as it comes (PAID / PENDING / FAILED / NEEDS_REVIEW). A capture that committed `CAPTURING` before the change is not "unsent" | Undoing, refunding or reversing a sent capture (not built) |
| `CAPTURE_UNKNOWN` | Reconcile **reads** PayPal only: a capture found → PAID / PENDING as verified; none found → state stays `CAPTURE_UNKNOWN` ("not captured as of the last lookup; will still be recorded if PayPal later shows one"). **No new capture attempt**, even inside the retry window | That the earlier request did not land |
| `CAPTURE_PENDING` / `NEEDS_REVIEW` | Unchanged; reconcile reads and records | Resolution |
| `PAID` | Unchanged; approval shown invalid next to it | Refund |

**Decision point.** The validity check and the `ORDER_CREATED → CAPTURING` transition run in **one** `BEGIN IMMEDIATE` transaction, through a guard hook on `PaymentStore.transition`. The PayPal call happens only after commit, outside any lock.

A change committed **before** that transaction stops the capture. A change committed **after** it doesn't stop the capture already sent. It still invalidates the approval for everything that follows.

**Recovery after invalidation.** Preview and approve again (new approval id). Its payment is a new record, allowed only if no earlier payment of the request is PAID or has an open outcome (X1 / X2). An earlier `NEW`, `FAILED` or capture-refused `ORDER_CREATED` record stays as history and can never be captured.

## 6. Determinism, confirmations, atomic approval

### 6.1 Preview digest

- `previewDigest = SHA-256(canonical JSON)` of the snapshot content, versioned `approval-digest-1`.
- **Canonical form:**
  - keys sorted, arrays in a defined order (items by request line position + id, fees by index, findings by code + key);
  - integers only for money (minor units);
  - strings exactly as stored;
  - no floating point, no locale formatting.
- **Included:** binding, all values with their origins, all findings with args, payee fingerprint, rules versions, and the Singapore day used for the lead-time check (`asOf`).
- **Excluded:** approver and timestamps.
- The same stored data gives the same digest across calls and restarts (tested).
- A day change can change the lead-time result and therefore the digest. The approve call then returns `BASIS_CHANGED` and the user reviews again.

### 6.2 Confirmations are bound to the preview

- Each CONFIRM finding has a key `code:SHA-256(canonical args)`. The args include the concrete values, e.g. line id, field, request text, quote text, fee kind and amount.
- The approve request sends `previewDigest` + the set of confirmed keys.
- The server requires:
  - the recomputed digest = the sent digest;
  - the confirmed keys = **exactly** the recomputed CONFIRM keys.

  Extra, missing or stale keys → `422 CONFIRMATIONS_MISMATCH`.
- Because findings are part of the digest, a confirmation can't carry over to changed content. The snapshot stores the keys with the digest they were given for.

### 6.3 Approve: re-check and save atomically

One `BEGIN IMMEDIATE` transaction:
1. authorise (`canApproveRequest`);
2. idempotency: same key + same payload → `REPLAYED`; same key + other payload → `KEY_REUSED`;
3. **recompute** the preview from the DB inside the lock;
4. any BLOCK → `422 BLOCKED`;
5. digest differs → `409 BASIS_CHANGED` (with the new preview);
6. confirmations differ → `422`;
7. an ACTIVE approval exists for the request: same digest → `EXISTING`; else `ALREADY_APPROVED` (revoke first);
8. insert the approval + audit row; commit.

On any refusal nothing is written. No PayPal or model call happens in this path.

| Situation | Result |
| --- | --- |
| Preview open, another tab changes the basis | step 5: `BASIS_CHANGED`, nothing stored |
| Double click | step 2: one row |
| Two pages approve at once | SQLite serialises writers; the second hits step 7 |
| Approval → payment | create record in a transaction (validity + X1 / X2 + amount from the snapshot); body carries only an idempotency key; unknown fields refused |

## 7. Access: `canApproveRequest` / `canPayRequest` (policy.ts)

```ts
// Principal grows with access control (design §6.4); today only LOCAL_DEV exists.
export type Principal =
  | { kind: "LOCAL_DEV" }
  | { kind: "BUYER"; id: string }
  | { kind: "APPROVER"; id: string };

/** Preview, approve. Recommended rule (§11 Q3): only an approver explicitly assigned to this request. */
export function canApproveRequest(principal: Principal, requestId: string): boolean;

/** Create payment record, create order, capture, reconcile. Recommended rule: only the owning buyer. */
export function canPayRequest(principal: Principal, requestId: string): boolean;

/** Revoke: the assigned approver or the owning buyer (revoking can only stop a payment). */
export function canRevokeApproval(principal: Principal, requestId: string): boolean;

/** What the snapshot records about who acted. Never taken from the browser. */
export function actorOf(principal: Principal): { kind: Principal["kind"]; id: string | null; authenticated: boolean; label: string };
```

| Principal | read | approve / preview | pay | revoke |
| --- | --- | --- | --- | --- |
| `LOCAL_DEV` (today, loopback `next dev` only) | yes | yes | yes | yes — recorded `authenticated: false`, label "local developer (not signed in)"; the same person approves and pays, **no separation of duties** |
| Buyer owning the request | yes | no | yes | yes |
| Approver assigned to the request | yes | yes | no | yes |
| Other buyer / unassigned approver | no (404) | no (404) | no (404) | no (404) |
| Unassigned existing records | reachable only in local dev mode; never given to Buyer A by default | — | — | — |

Rules:
- Every approval and payment route calls these **on the server per request**, before reading the object, with the same 404 for "missing" and "not allowed".
- Capture and reconcile check `canPayRequest` again, so a revoked right takes effect on the next request.
- The approve transaction checks `canApproveRequest` inside the lock.
- Approval and payment reads use `canReadRequest`.
- Audit rows: approve, revoke, payment create / order / capture / reconcile, denied attempts — actor, action, object id, outcome, time; never quote text or keys.
- Approvals made under `LOCAL_DEV` stay labelled so and are never re-attributed to an account.
- **Not implemented today:** accounts, sessions, ownership, assignments. Until then these functions return true only for `LOCAL_DEV`, and pages state "local development demo — no sign-in, no multi-user isolation".

## 8. Examples

### A — complete and reviewed: allowed

- Request `[TEST] approval A (SYNTHETIC)`: tumbler 500 ml × 20 pcs, material "304 stainless steel"; gift box × 20 pcs, no attributes. Budget USD 15.00; FOB Ningbo.
- Quote v1 FULL_QUOTE (latest of its series):
  - "tumbler, 304 stainless steel, 20 pcs × USD 0.45 = USD 9.00";
  - "gift box 20 pcs × USD 0.15 = USD 3.00";
  - **Total USD 12.00**; "packing included";
  - "100 % T/T before shipment"; FOB Ningbo; 20 days.
- MOCK run on current rules. All critical fields reviewed (incl. the material).
- Gate:
  - no BLOCK, no CONFIRM;
  - INFO B6 (MOCK), Y2, Y3, M9 n/a (budget within), L2 match.
- **This payment USD 12.00** = stated total = 9.00 + 3.00. Packing included, not added. Not in this payment: none named. "This version does not calculate the full landed cost."

### B — inconsistent: blocked

- **B1:** quote says **18 pcs** tumbler; request 20 → I4 `QTY_DIFFERS`.
- **B2:** lines 9.00 + 3.00, stated **Total USD 12.60** → M4.
- **B3:** the quote says "stainless steel tumbler" with no grade, while the request requires "304 stainless steel" → I6 `KEY_ATTRIBUTE_NOT_QUOTED`. **No tick can pass it.** Paths: updated quote stating 304, or the buyer drops the requirement in the request.
- **B4:** an older version (v1) after a v2 exists → B4.
- **Existing 30 / 70 sample** → P2 (unchanged sample).
- In each case the Approve button is disabled and the API refuses with the same codes; nothing is stored.

### C — supplier amount fixed; other fees outside this payment

- **C:** A plus the line "Import duties and VAT at destination: not included, payable by the buyer to customs; amount depends on destination". Reviewed: TAX_DUTY, NOT_INCLUDED, payee GOVERNMENT, payer BUYER, amount not stated.
  - Result: F7c → **allowed after confirmation**. The duty is not owed to the supplier and is outside the total, so the supplier amount is fixed. Payee and payer are stated and reviewed, and the missing amount is disclosed.
  - Page:
    - "This payment: USD 12.00 to the Sandbox test merchant (supplier goods total)."
    - "Not in this payment — unknown: import duties and VAT, amount unknown, paid by you to customs."
    - "This version does not calculate the full landed cost. TradeProof does not calculate taxes or duties and does not check tax compliance."
- **C-unverified:** also "Freight forwarder handling approx. USD 25, paid by buyer to forwarder", amount not reviewed → listed under **unverified** ("approx. USD 25 — quote wording, not verified by you"). Still allowed after confirmation; it's not in the payment.
- **C′:** "Mould fee: to be confirmed, payable to us" → **BLOCK** F5 (owed to the same supplier and outside the total).
- **C″:** the duty line with no payee stated → BLOCK F6.

## 9. Acceptance design (after implementation)

### 9.1 Key automated tests (temp DBs, SYNTHETIC fixtures, labelled MOCK gateway; no model, no PayPal)

1. **Rules:** each BLOCK / CONFIRM / INFO code from a minimal fixture.
   - Examples A, B1–B4, C, C-unverified, C′, C″ give exactly the expected codes, money figures and fee lists.
   - **Key vs descriptive:** a missing required material blocks and no confirmation key exists for it; a missing descriptive note is INFO.
2. **Latest only / supplement:**
   - an older version → B4, and no confirmation unlocks it;
   - supplement + base composition with the source per field;
   - unresolved inheritance, skipped newer full quote and supplement chain → B5.
3. **Determinism:** same DB → same digest across two calls and a service restart; shuffled insertion order → same digest; changed fee amount / pairing / rules version → different digest.
4. **Confirmations:** missing, extra or stale keys → 422; keys from an earlier preview after a change → 409 / 422; nothing stored.
5. **Tampering:** approve / payment bodies with `amount`, `currency`, `payee`, `snapshot` → 400; the MOCK gateway receives exactly the snapshot amount.
6. **Atomic approve:** a basis change between preview and approve → `BASIS_CHANGED`, 0 rows; same key → 1 row; same key + other payload → `KEY_REUSED`; two connections → exactly 1 ACTIVE row.
7. **Invalidation matrix §5.3:**
   - each "invalidates" row → refusal at payment create / order / capture, MOCK capture count 0; each "no effect" row stays ACTIVE;
   - **edit-then-revert** (two revisions) → INVALIDATED;
   - new approval → new id; the old snapshot is byte-identical.
8. **Payment boundaries §5.4**, one test per row:
   - invalid at `ORDER_CREATED` → capture refused;
   - invalid during `CAPTURE_UNKNOWN` → reconcile reads, never re-captures, records PAID if found;
   - invalid after `CAPTURING` committed → capture outcome recorded;
   - PAID stays PAID;
   - X1 / X2 block a second payment.
9. **Immutability:** triggers refuse UPDATE / DELETE on the three new tables.
10. **Sources:**
    - statements with numbers never change the amount;
    - PROPOSES_NEW without a link → BLOCK, with a link → CONFIRM;
    - older-rules run → BLOCK; pending critical field → BLOCK;
    - preview works without any comparison-page visit.
11. **Currency / budget / ceiling:** CNY → BLOCK (no conversion); over budget → BLOCK; budget in another currency → BLOCK; above ceiling → BLOCK.
12. **Policy:** stub principals per §7 table → allowed / 404 on every route.
13. **Migration:** rehearsal on a copy (existing tables, rows, triggers unchanged; integrity / FK ok).

No new worker-thread test (open segfault, `docs/diagnostics/budget-threads-segfault.md`). Concurrency uses two connections in one process.

### 9.2 Owner's manual acceptance (five steps, seeded records only)

1. **A:** preview → binding, the money figures, origins, the landed-cost sentence; approve; refresh; snapshot unchanged, "local developer (not signed in)".
2. **B1–B4:** reasons with paths; Approve disabled; B3 offers no tick.
3. **C:** "Not in this payment — unknown / unverified" lists; approve only after confirming.
4. **A, second tab:** change a quantity, then change it back → still invalid; Pay refused; a new approval is needed.
5. **Real Sandbox payment** (30 / 31 Oct, only with the owner's explicit go-ahead): fresh valid approval of **Example A, USD 12.00** → PAID; then invalidate → payment still PAID.

### 9.3 Test data

- `scripts/e2e/seed-approval.mjs` (like `seed-replies.mjs`) creates `[TEST] approval … (SYNTHETIC)` records from the new SYNTHETIC samples, with MOCK replay runs and reviews written through the service API.
- Existing samples and accepted records (LA-1…5, `PR-302DD831`, `PR-6117B2A1`) are not modified.
- Counts are re-counted from the DB before any checklist is written. No paid call.

## 10. Implementation (after the owner's approval of this revision)

### 10.1 Reused as is

- `ComparisonService` / `compareExtraction` / `runRefusal`.
- `ExtractionStore`.
- `ReplyService.buyerStatements()` / `updatedQuoteStatus()`.
- `parsePaymentTerms`, `readMoney`, `money.ts`.
- `PaymentService` / `PaymentStore` / gateway / `verifyCapturedOrder`.
- `policy.ts`, the migration runner, the idempotency + fingerprint pattern, the local guard.

### 10.2 Minimal new code

- `src/lib/approval.ts` (pure): `requestFingerprint`, `composeConditions` (§2.2), `evaluateApproval → {status, findings, snapshot, digest}`, `canonicalJson`, `validityProblems(snapshot, recordsSince)`.
- `src/server/approval/` (schema, store, service, http, index).
- Small changes to payments:
  - `PaymentService.createRecordFor(amount, currency, label)`;
  - a capture guard evaluated inside the `CAPTURING` transition;
  - read-only reconcile when the approval is invalid.
- Export of the comparator's `usedValue`.
- `policy.ts` functions of §7.
- Routes (through policy and the local-dev guard):
  - `GET  /api/procurements/:id/approvals/preview?series&version&run[&baseRun]`
  - `POST /api/procurements/:id/approvals` `{seriesId, versionId, runId, baseRunId?, previewDigest, confirmed[], key}`
  - `GET  /api/procurements/:id/approvals/:approvalId`
  - `POST /api/procurements/:id/approvals/:approvalId/revoke` `{reason, key}`
  - `POST /api/procurements/:id/approvals/:approvalId/payment` `{key}` → `…/payment/order`, `…/payment/capture` `{orderId?}` (cross-check only), `…/payment/reconcile`
- Page: an "Approval" section reached from the comparison page. No other redesign.

### 10.3 Order

1. Pure library + rule / digest tests.
2. Migration (next free number, expected v14): `VACUUM INTO` backup → rehearsal on a copy → owner OK → real DB.
3. Service + HTTP + policy.
4. Page.
5. Payment linkage with the MOCK gateway.
6. SYNTHETIC samples + seed script + browser check.
7. Owner acceptance (§9.2 steps 1–4).
8. One real Sandbox payment (step 5) only with the owner's go-ahead.

### 10.4 Schedule impact and deferred items

- **29 Oct:** this design (two revisions). The build starts after approval of revision 2.
- **30 Oct:** steps 1–6 realistic. Steps 7–8 may spill into 31 Oct morning.
- **31 Oct morning (recommended, §11 Q4):** finish the local approval → payment loop first; access control after it.
  - **No multi-user deployment** until access control is accepted.
  - If access control isn't accepted by the mid-point, A5 / A6 / A10 are reported open, and the 1–2 Nov deployment stays single-user / local or waits.
- **Deferred, not done:**
  - **A–D readiness grade** (planned for 29–30 Oct) — not in this design; the gate list and money figures do not replace it and are not called a grade. New date to be set with the owner.
  - **Full trade-sheet fee preview** beyond §4.1.

## 11. Product decisions — recommended, waiting for the owner's confirmation

| # | Decision | Recommended (recorded as the owner's proposal, not yet confirmed) | Effect in this design |
| --- | --- | --- | --- |
| Q1 | Payment scenario of v1 | **One full payment of the stated USD quote total** | §4.2; P2 blocks deposits; new SYNTHETIC 100 % samples |
| Q2 | Over budget | **Block; after the budget is changed in the request, re-save and re-review the quote** | M7 / M8 BLOCK; path §2.1 |
| Q3 | Who approves, who pays | **The assigned approver approves; the owning buyer pays** | §7 table; under `LOCAL_DEV` both, labelled, no separation of duties claimed |
| Q4 | Order of work | **Local approval → payment loop first; multi-user deployment only after access control is accepted** | §10.4 |

Technical choices I'll follow unless told otherwise:
- USD 100.00 technical ceiling (code constant; not an authorisation);
- any new review invalidates;
- one payment per approval; a new one only when no earlier payment is PAID or open.

## 12. Small to-dos kept separate (not part of this build)

- Question cards: a pointer to the *Paste a supplier reply* form.
- Wording: the draft's sticky **Save** vs the reply form's **Save reply**.

## 13. Not claimed

- No authenticated approver, access control, multi-user isolation, separation of duties or two-person approval.
- No tax, duty or full landed-cost calculation; no tax compliance.
- No currency conversion, staged payment, escrow or refund.
- No cancellation of a PayPal order or of a sent capture.
- The payee is a Sandbox test merchant, not the supplier; Sandbox moves no real money.
- A gate pass means "the rules above found nothing blocking". It is not a guarantee about the supplier or the deal.

## 14. Revision 2 change log (owner review, 29 Oct)

| # | Owner's point | Change |
| --- | --- | --- |
| 1 | Key vs descriptive gaps | §3.2: key attribute = explicit request material / specification / customization; missing supplier basis → BLOCK I6 (no tick); descriptive → INFO; limitation for free-text requirements |
| 2 | Latest complete conditions only; supplement composition | §2.2, B4 now BLOCK without override; supplement = itself + explicit full base, field-level source table, chains / skipped full quotes blocked |
| 3 | Edit-then-revert basis; payment boundaries | §5.3 event basis per row; §5.4 table per payment state; no promise to cancel a sent payment |
| 4 | Landed-cost wording; excluded / unknown / unverified | §4.1 new wording and three separate lists |
| 5 | A–D deferred; policy functions | §10.4 deferred list; §7 signatures and table |
| 6 | Deterministic digest; confirmations bound; atomic approve | §6.1–6.3 |
| 7 | New samples only for scenarios | §4.2 / §9.3: old 30 / 70 and 50 / 50 samples unchanged; new files marked SYNTHETIC |
| 8 | Ceiling ≠ authorisation | §4.2; real acceptance uses Example A, USD 12.00 |
| — | Recommended decisions | §11 Q1–Q4 recorded as recommendations awaiting confirmation; WARN renamed CONFIRM and limited to cases with supplier evidence |

## 15. Revision 3 — as built (29 Oct 2026, after the owner's confirmation)

### 15.1 Owner decisions (confirmed 29 Oct, no longer open)

| # | Decision | Built as |
| --- | --- | --- |
| Q1 | One full payment of the stated USD quote total | `STAGED_PAYMENT` blocks deposits; this payment = stated total = Σ reviewed lines |
| Q2 | Over budget blocks; change the budget, then get a consistent basis again | `OVER_BUDGET`, `BUDGET_NOT_COMPARABLE` block; a budget change makes the quote's request snapshot stale (`REQUEST_CHANGED_SINCE_QUOTE`) |
| Q3 | Assigned approver approves, owning buyer pays | `canApproveRequest` / `canPayRequest` / `canRevokeApproval` / `actorOf` in `policy.ts`; today only `LOCAL_DEV` passes and every approval records "not signed in — local demo, no separation of duties" |
| Q4 | Local loop first; multi-user deployment only after access control is accepted | unchanged schedule rule |

### 15.2 Six further boundaries (owner, 29 Oct) and how they are built

| Boundary | Built (supersedes earlier text) | Evidence |
| --- | --- | --- |
| A correction of a key value needs valid quote evidence; a buyer statement without basis cannot become a condition by ticking | A `CORRECT` review of a critical value counts only if the field's excerpt was located in the stored quote text **and** the corrected value appears in it (numbers compared as numbers, text normalised; interpreted codes need the located excerpt). Otherwise `CORRECTION_WITHOUT_EVIDENCE` (BLOCK). A supported correction gives `USES_CORRECTION` (CONFIRM) | unit "corrections …" (USD 11.00 not in excerpt → BLOCK; misread 0.54 corrected to the excerpt's 0.45 → CONFIRM) |
| With a deadline, a lead time whose start point or "approx." wording cannot be checked blocks | With a required ship date or delivery date: anything but `LEAD_TIME_FITS` (reviewed) → `LEAD_TIME_UNVERIFIABLE` / `LEAD_TIME_TOO_LATE` (BLOCK, path: ask for a lead time from a clear start or change the date). Delivery date only → BLOCK (transit not known). No deadline → INFO | unit "lead time with a deadline" |
| A new condition linked to the current quote must be shown to be in that version (extracted, server-compared, reviewed); a link alone does not pass | `NEW_TERMS_LINKED` (CONFIRM) only if the version is the latest, passes the whole gate, **and** its own (not inherited) value for that field and item is reviewed; else `NEW_TERMS_NOT_IN_VERSION` / `NEW_TERMS_WITHOUT_QUOTE` (BLOCK) | unit "linked updated quote …" |
| Notes and additional requirements are not all non-key; if unclear, the user classifies with a reason | Every non-empty item note and the additional requirements of the quote's request snapshot must be classified per version: *not key* (reason), *key and stated in the quote* (reason + verbatim excerpt found by the server in the version or its base), *key and not stated* (BLOCK). Unclassified → `REQUIREMENT_NOT_CLASSIFIED` (BLOCK). Stored append-only (`requirement_classifications`); a new classification invalidates an approval | unit "free-text requirements …" |
| An unrelated ordinary reply does not invalidate; only readings, terms or links that affect the basis do, with the reason | The statements digest covers only buyer readings (answer id, classification, quote-update flag, contradiction) and reply → quote links of the series. A saved reply without a reading changes nothing. Reasons shown: `STATEMENTS_CHANGED`, `REQUEST_REVISED:rN`, `REVIEWS_CHANGED`, `NEWER_QUOTE_VERSION:vN`, `CLASSIFICATIONS_CHANGED`, `PAYEE_CHANGED`, `RULES_CHANGED`, `QUOTE_TEXT_CHANGED` | unit "new review, newer quote version, payee change …; an unrelated reply … does not" |
| Capture vs basis change has an explicit transaction order; sent or unknown requests keep their real state and are not re-sent automatically | `PaymentStore.transitionChecked`: `BEGIN IMMEDIATE` → approval validity check (read-only) → `ORDER_CREATED/CAPTURE_UNKNOWN → CAPTURING` → `COMMIT` → PayPal call. The same guard applies to `NEW/ORDER_CREATING → ORDER_CREATING` before any create request. **Change from §5.4:** with an invalid approval, no create request is sent or re-sent (not even with the same PayPal-Request-Id); `CAPTURE_UNKNOWN` stays as it is and reconcile only reads PayPal (a capture found is recorded PAID). Nothing undoes a sent capture | unit "capture decision point …" (a second writer cannot commit during the check), "invalid before order creation …", "unknown capture outcome, then invalid …" |

### 15.3 What exists now

- **Schema v14** (next free number): `approvals` (immutable), `approval_events` (append-only; first INVALIDATED / REVOKED is terminal), `approval_payments` (append-only), `requirement_classifications` (append-only). Triggers refuse UPDATE / DELETE.
- **Code:**
  - `src/server/approval/` — `evaluate.ts` (gate, snapshot, canonical JSON, digest), `store.ts`, `service.ts` (preview, atomic approve, validity, revoke, classify, payment start / order / capture / reconcile), `http.ts`, `index.ts`, `schema-sql.ts`;
  - `src/server/payments/` — optional guard on create / capture / reconcile, `transitionChecked`, result `APPROVAL_INVALID`;
  - `policy.ts` — the four entry points;
  - `src/lib/comparison.ts` — `usedValue` exported, no logic change;
  - page `/procurements/:id/quotes/approval` (entry link on the comparison page), English catalogue `en.approval`.
- **Payment steps for approvals are refused over HTTP in this phase** (`409 PAYMENTS_NOT_ENABLED`) unless `TRADEPROOF_APPROVAL_PAYMENTS=sandbox` is set (it is not). They are exercised only with the MOCK gateway in tests. **No real Sandbox payment of an approval exists; none is authorised.** Example A's USD 12.00 Sandbox transaction waits for the owner's decision after this acceptance.
- **SYNTHETIC data:** new samples `approval-quote-{a,b,c}.synthetic.md` + `approval-model-outputs.synthetic.json`. The original 30 / 70 sample is reused unchanged as a blocked case. Seed: `scripts/e2e/seed-approval.mjs`; browser check `npm run e2e:approval`.

### 15.4 Deviations and limits (honest list)

- **Concurrency:** SQLite serialises writers. "Two pages at once" is tested with two connections (a held write lock makes the second approve wait / fail without writing; afterwards it gets `EXISTING`), not with parallel processes. No new worker-thread test (open segfault).
- **Unit of a line:** required to be reviewed when the request line has a unit.
- **Validity checks run when an approval is viewed or used.** The `INVALIDATED` event is written at the first such check, not at the moment of the change. Correctness doesn't depend on that, because the facts are append-only.
- **A request revision after the approval is judged by its fingerprint.** A title-only edit does not invalidate. An edit that is later reverted does.
- **Not built:**
  - A–D readiness grade (deferred);
  - trade-sheet view beyond the money lists;
  - zh-CN labels on the approval page;
  - access control, accounts, assignments;
  - real Sandbox payment of an approval;
  - supplement approval in the browser (covered by the service and rules; no SYNTHETIC supplement case in the browser check).

## 16. 30 Oct 2026 — approval → payment loop prepared (MOCK verified; real Sandbox not run)

### 16.1 What was added (no migration; schema stays v14)

- **Controlled switch** `src/server/approval/payment-mode.ts`, read from the server environment only:
  - unset → **OFF**: every payment step 409 `PAYMENTS_NOT_ENABLED`, nothing written (the state on this machine);
  - `TRADEPROOF_APPROVAL_PAYMENTS=sandbox` → **SANDBOX**, real PayPal Sandbox calls, **only on the main database**;
  - `TRADEPROOF_APPROVAL_PAYMENTS=mock` → **MOCK**, simulated PayPal (file-backed, `src/server/payments/mock-gateway.ts`), **only when `TRADEPROOF_DB_PATH` points at a copy**; MOCK records get sku `TP-APPROVAL-MOCK` and "(MOCK PayPal — no PayPal request)" in the item name;
  - anything else, or MOCK on the main DB / SANDBOX on a copy → **REFUSED** (treated as off; the reason is shown).
- **Payment panel** on the approval page (`PaymentPanel.tsx`): environment, amount from the approval, quote version + text hash, approval basis (id, preview digest, time, request revision), fixed test payee, "local demo, not signed in, no separation of duties; no multi-user deployment before access control". Buttons post ids only. One step at a time on the page; nothing is retried automatically. SANDBOX uses the same PayPal JS SDK v6 integration as `/sandbox-demo`; MOCK offers "Simulate buyer approval (MOCK)" (route `…/payment/mock-approve`, 404 outside MOCK).
- `LinkedPayment` carries order / capture status, sku, item name, last error, paid time (read from the existing columns).
- `scripts/e2e/seed-approval.mjs` can seed one case (`… "label" A`); `scripts/e2e/approval-payment.e2e.mjs` (`npm run e2e:approval-pay`) drives the loop in MOCK mode on a copy and refuses the main DB.

### 16.2 Change against §5.4 / §15.2 (owner rule of 30 Oct: no automatic POST retry; unknown outcomes only read)

- Before: with a still-valid approval, pressing Capture again or Reconcile after an unknown capture outcome could **re-send** the capture with the same PayPal-Request-Id (PayPal de-duplicates it). Reconcile of an unknown order creation re-sent the create with the same id.
- Now, for approval payments (`noResendAfterUnknown`):
  - once a capture may have been sent (`CAPTURE_UNKNOWN`, or `CAPTURING` with an expired lease, e.g. after a restart), Capture and Check **only read** PayPal. A capture PayPal shows is verified and recorded `PAID`; none found → `CAPTURE_UNKNOWN` stays ("never sent again"). A stale `CAPTURING` becomes `CAPTURE_UNKNOWN` by that read, never "not sent".
  - Check of an unknown order creation sends nothing (an order can't be looked up without its id). Only an explicit **Create PayPal order** click repeats the same create request (same PayPal-Request-Id; an uncaptured order moves no money).
- The original `/sandbox-demo` path keeps its 21 Oct behaviour (unchanged, its USD 1.00 record is PAID).
- **Limit:** a capture that stays `CAPTURE_UNKNOWN` blocks a new payment for the request (`PAYMENT_OUTCOME_OPEN`) until a person resolves it; there is no automatic resolution.

### 16.3 Unchanged

- Validity re-checked at record creation, order creation and capture; the capture check and the `CAPTURING` claim run in one short `BEGIN IMMEDIATE`; PayPal is called after commit (no DB lock held during the network wait).
- `canApproveRequest` / `canPayRequest` / `canRevokeApproval` remain the entry points; only `LOCAL_DEV` passes; no separation of duties is claimed.
- The real Sandbox USD 12.00 transaction (AP12) was **not authorised** when this section was written; **done later on 30 Oct** with the owner's authorisation (PAID, verified; `docs/setup-status.md`). Its basis was a MOCK extraction — not a real AI → payment chain.

## 17. 30 Oct 2026 (night) — approvals under sign-in (schema v15)

- `canApproveRequest` = an approver currently assigned by the owning buyer (re-checked inside the approve transaction); `canPayRequest` = the owning buyer; `canRevokeApproval` = owner or assigned approver; the preview is readable by both. Actor from the session: new approvals store `APPROVER`, account id, authenticated.
- New validity reason `APPROVER_UNASSIGNED`: a REVOKE grant row for the approving approver at or after the approval. Append-only, so re-assigning does not restore the approval. Rules version unchanged (no historical approval is re-judged by a rules change). **31 Oct (v17): "at or after" is now decided by grant sequence (`approvals.approver_grant_seq`), not by timestamps; approver approvals from before v17 get `GRANT_BASIS_UNKNOWN` and cannot pay — `docs/access-control.md` §12.**
- `LEGACY_UNAUTHENTICATED_APPROVAL`: approvals made before sign-in (`LOCAL_DEV`, not authenticated) are kept unchanged and shown, but payment start / order / capture refuse them (`APPROVAL_NOT_PAYABLE`). PR-F9B23762's approval (`LOCAL_DEV`) stays with its PAID USD 12.00 payment; nothing was re-checked, queried or re-captured.
- Audit rows (approve OK / denied, approval revoked, payment refused) are written after COMMIT. Details: `docs/access-control.md`.
