# TradeProof Copilot v1 — implementation plan (design only)

> Written **1 Nov 2026 (SGT)** from a reading of the code at `b42f693` (schema v17); **revised the same day after the owner's decisions** (five buttons, no free text; real adapter + necessary migration are part of the 3–4 Nov scope; real calls authorised separately; read-only business facts; re-authorisation before returning an answer; late-response handling). **Nothing here is built.** No route, page, table, migration, dependency or model call was added for this document. Requirements stay `docs/product-brief.md` §4a and **CP1–CP12** (`docs/design-24oct-additions.md` §8), refined in §10 below. Cases: `docs/copilot-cases.md`.

> **Status 2 Nov 2026:** built as planned (server, v18 migration, shared ledgered call, panel) — **MOCK-verified; real-model acceptance and owner acceptance open.** Details and evidence: `docs/setup-status.md` "2 Nov 2026". Differences from the text below, decided while building:
> - §5 sentence limit: up to **12** sentences (each ≤ 400 characters) so a MOCK / model explanation can cite every BLOCK; §6.1 per-ask reservation cap **US$0.04** added (plus an optional run cap for the authorised run).
> - §6.3 idempotency scope = account + request + request key; the answer is reused only for the same intent / version / run / basis, otherwise 409 KEY_REUSED; after a restart the ledger key refuses a second call (ALREADY_ASKED). No answer table (G4 kept).
> - §2.5 basis is 10 hashed parts (request, quote, run, reviews, statements, classifications, approvals, drafts, replies, payments) so the panel can name what changed.
> - §4.2 step 6: a signed-out session → 401; another account or removed access → 404; no answer text either way.
> - **2 Nov (later):** §6.3 made restart-safe and payload-bound — the ledger key carries account + record + click key (an exclusive prefix checked inside the reservation transaction) plus the question / version / run / basis binding; repeats report the first call's ledger state; the app stores no answers, only an authorised run collects evidence (`onEvidence`). §6.4 decided by the owner: real run on the **main DB** with dedicated [TEST] records; final list in `docs/copilot-cases.md` §2.9 (L1–L6, all five buttons).
> - §6.4 **open question for the owner (answered later on 2 Nov: main DB):** the shared budget lives in the main DB's ledger, so a run on a *copy* would not count against the global limits. Recommended: run on the main DB with six NEW [TEST] SYNTHETIC records (backup first). See `docs/copilot-cases.md` §2.9.

## 0. Owner decisions (1 Nov)

1. **Five question buttons, no free text** in v1.
2. The ledger migration is **not** a reason to leave real Copilot acceptance out: 3–4 Nov covers the necessary migration, the real adapter wiring, MOCK tests and the preparation of real calls. Migration number = the next free number at execution (today that would be v18).
3. **Real calls** happen only after the owner receives the case list, the number of calls and a cost cap, and authorises them (§6.4).
4. If time runs short, the trade-offs are listed explicitly (§9.2). **MOCK alone does not count as "Copilot done".**
5. Business facts are read through new **read-only** methods; no read path that writes `INVALIDATED` events (§2.2).
6. Re-authorise on every request and again after the model returns, drop late responses, clear on sign-out / account switch, re-check on focus (§4.2). No promise to retract what a user has already seen or copied.
7. Each button produces a **model explanation of the current facts with evidence**. Fixed templates and MOCK output are never labelled as real AI. Amounts, approval eligibility and payment status come from deterministic code.

## 1. The five buttons

The panel sits inside **one** procurement record, bound to the quote version selected on the Quotes page. There is no free-text input. Each button maps to an intent with a fixed, deterministic fact source.

| Button (EN) | Intent | Deterministic source (existing code) | Facts in the bundle | Next-step links (built on the server) |
| --- | --- | --- | --- | --- |
| What differs between the quote and my request? | `DIFFERENCES` | `ComparisonService.compare` → `Comparison` rows / notes / questions / cost view (`src/lib/comparison.ts`) | DIFFERENCE / OPEN rows (field, item ref, request value, quote value + origin, note code); MATCH count | Compare page |
| Why can't this be approved? | `WHY_NOT_APPROVABLE` | `ApprovalService` evaluation (`evaluateApproval`: status, findings BLOCK / CONFIRM / INFO); approvals with validity computed **read-only**; `approval-entry.ts` refusals; access facts | gate status; BLOCK then CONFIRM findings (code + EN label + subject); role facts; Active / No longer valid / Revoked approvals with reasons | Approval page (series + version + **explicit run**); request page Access (owner) |
| What is still open after the supplier's reply? | `AFTER_REPLY` | `ClarificationService.open` / `list`, `ReplyService.view`, `src/lib/replies.ts` (`questionState`, `basisChanges`, `contradictions`, `quoteUpdateFor`) | per Qn: state, updated-quote-needed, contradictions, basis changes; replies saved but not linked / answered | Draft page, reply form |
| How much is this payment, and which costs are unknown or excluded? | `PAYMENT_AMOUNT` | `Evaluation.snapshot.money`; stored approval amount; payment status as the page shows it to that role | this Sandbox payment (exact minor units + currency, basis FULL_STATED_TOTAL) or "no payable amount" + reason; included / excluded / unknown / unverified / duplicates / not applicable; `landedCost = NOT_CALCULATED_IN_THIS_VERSION`; payment status | Approval page |
| Where do I go next? | `NEXT_STEP` | fixed precedence over the facts above (§3.3), role-aware | the chosen step + the facts behind it | one existing page |

## 2. Data and evidence

### 2.1 Context builder (`src/server/copilot/context.ts`, new)

`buildCopilotFacts(principal, requestId, { seriesId, versionId, runId | null, baseRunId | null, intent })` → `FactBundle | null`.

- Starts with `canReadRequest` (via `readRecordFor`, the reserved entry). `null` → the same 404 body as a missing id. Nothing is gathered, nothing is sent to a model, nothing is written.
- Series / version / run come from the Quotes page selection and are re-resolved **through the request id** (a child of another request → 404). The run is chosen with the rule in `src/lib/approval-entry.ts`. The builder never switches version: an older version is answered "for version N only — version M has been saved since", and the gate reports `NOT_LATEST_VERSION`.
- **Only this record.** No lists, search, other requests or buyers, ledger totals or configuration. The model input is built **only** from the bundle.
- **Same visibility as the pages:** a role never gets more through the Copilot than the existing page shows it.

### 2.2 Business facts are read-only (owner decision 5)

**Gap G2:** `ApprovalService.view` / `list` call `validity(…, record = true)`, which **writes** an `INVALIDATED` event when it finds a problem. The approval page relies on this. The Copilot must not use it.

New read-only methods. No existing behaviour changes.

| New method | Does | Never does |
| --- | --- | --- |
| `ApprovalService.readFacts(principal, requestId, ids)` | `canReadRequest`; `gather` + `evaluateApproval` (pure); approvals of the request with `validity(…, false)` (computed, not stored); events and payments as already stored | `recordInvalidation`, `addEvent`, any transaction that writes |
| `ComparisonService.compare` (existing) | already read-only (pure `compareExtraction` over stored rows) | — |
| `ClarificationService.open` / `list`, `ReplyService.view` (existing) | read-only (checked 1 Nov) | — |

**The two kinds of writes are kept apart:**

| Kind | Allowed writes | Where |
| --- | --- | --- |
| Business facts (requests, quotes, runs, reviews, drafts, replies, answers, approvals, approval events, grants, payments) | **none** | the fact builder uses only the read-only methods above |
| Model call accounting | ledger row per attempt (reserve → settle / release / unknown), exactly as for extraction | `BudgetStore`, purpose `COPILOT_ANSWER` (§6.2) |
| Session handling | idle-timeout refresh by the auth layer, as on every page | auth (unchanged) |

Tests check the separation (`docs/copilot-cases.md` §2.6). Counts and hashes of every business table are identical before and after a Copilot ask, including asks where an approval is found invalid by computation. The only rows that may change are ledger rows (LIVE only) and the session row.

### 2.3 Facts and citations

Each fact gets a server-assigned id (`F1…Fn`, per response) and a source taken from stored ids, never from model text:
- request (id, ref, revision);
- quote version (series id / ref, version id, version number, latest number, content kind, text-hash prefix);
- extraction run (id, mode, status, check rules);
- review (id, path, state);
- excerpt (version id + stored excerpt in its original language, labelled *untrusted supplier text*);
- approval (id, computed state + reason codes, grant seq);
- draft / reply / answer (ids, draft revision, Qn);
- payment status as the page shows it.

Amounts, gate status, question states, approval validity and payment status are deterministic facts. The model may refer to them only by fact id.

### 2.4 Missing basis — said, never filled

Fixed "not available" facts with reason codes:
- no quote saved;
- no run stored / no usable run (each reason listed);
- reviews pending;
- comparison refused;
- no draft / no reply / no approval;
- approval no longer valid;
- no payable amount;
- landed cost not calculated.

When a "not available" fact applies, the model is told so. The validator rejects any sentence that states a value for it.

### 2.5 Basis digest and outdated answers

The digest is SHA-256 over:
- request revision and latest version number;
- version id and run id;
- `reviewsDigest`, `statementsDigest`, `classificationsDigest`;
- approval ids + **computed** validity (read-only);
- latest draft revisions;
- reply / answer ids;
- payment statuses of the record.

`GET …/copilot/basis` recomputes it with no model call and no business write:
- equal → **Current**;
- different → **"Based on an earlier state (…changed). Ask again to refresh."** No automatic re-ask, so no paid call;
- 401 / 404 → the panel clears (§4.2).

## 3. Answer composition

### 3.1 Two layers, labelled

1. **TradeProof facts** (deterministic, always computed, always shown). Label: *"From TradeProof's own checks — not AI."* This layer is never called an AI answer.
2. **Explanation** (model, per button). It prioritises and explains the facts in plain English with fact-id citations, and is shown only if it passes the validator (§5). Labels:
   - **LIVE:** "AI explanation · <provider> <model> · checked against the facts above";
   - **MOCK:** "**MOCK** — canned test output, not AI";
   - no model configured / live not authorised / budget refused / failed check: "No AI explanation (reason)", with the facts layer only.

Amounts, approval eligibility and payment status are rendered **from the facts layer**. The explanation cannot change them, and a contradiction makes the validator drop the explanation.

### 3.2 Fixed refusals

There is no free text, so the "act for me" requests of the earlier plan cannot be typed. The boundary still holds by construction: `src/server/copilot/*` imports no write handler or service write method (static import test, CP5). Model text that claims an action is rejected (§5).

### 3.3 `NEXT_STEP` precedence (deterministic; first match wins; role-aware)

1. No quote.
2. No usable run (the Copilot never starts a run).
3. Key reviews pending.
4. Differences open and no draft → Compare page.
5. Questions Open / Partly answered → draft page.
6. `UPDATED_QUOTE_NEEDED` → Quotes page.
7. Gate BLOCKED → approval page.
8. Ready and no approver → Access (owner).
9. Approver assigned and nothing Active → owner "waiting for the approver"; approver → approval page.
10. Active approval and switch off → "payment is off in this demo".
11. PAID → nothing left.

## 4. Access and boundaries

### 4.1 Rules (CP1, CP5, CP7)

- A buyer sees only its own requests; an approver only its assigned ones. Same `canReadRequest`; same 404 for "not allowed" and "missing".
- The browser sends: request id (path), series / version / run ids, intent (one of five), idempotency key, CSRF token. Nothing else is accepted (unknown body fields → 422).
- Quote text, reply text, excerpts and buyer statements are untrusted data (§5.3).
- The Copilot is read-only on business data (§2.2) and sends no message.
- **Links** are built on the server from a fixed route list with ids from the bundle. The model can only pick a link id. URLs in model text are rejected, and the target page applies its own guard.

### 4.2 Re-authorisation, sign-out, account switch, late responses (owner decision 6)

**Server:**
1. Every POST / GET goes through `guard()` (session + CSRF on POST) and `canReadRequest`. Nothing is reused from a previous request.
2. Order of one ask:
   1. authorise;
   2. build facts;
   3. reserve budget (LIVE);
   4. call the model;
   5. close the ledger row (settle / unknown — the money may be spent either way);
   6. **authorise again**: re-resolve the session from the cookie, check it is the same account and that `canReadRequest` still holds;
   7. re-compute the basis digest;
   8. respond.
3. If step 6 fails → 401 / 404 with **no answer text**; the ledger row stays as closed in step 5.
4. If step 7 differs from the digest used for the call → the answer is returned marked **Outdated** (the money is already spent, so it is not silently thrown away). It is never shown as Current.
5. Responses carry `Cache-Control: no-store` and an `answerFor` block: account id (opaque hash), request id, version id, run id, basis digest, client request nonce.

**Client (`CopilotPanel`):**
1. Each ask carries a nonce. The panel keeps only the latest nonce per (account, request, version). A response whose nonce, account hash, request or version no longer matches the panel's current state is **discarded**. This covers late responses after navigation, version switch or account switch.
2. Answers live only in React state. No `localStorage` / `sessionStorage` / IndexedDB; a reload starts empty.
3. **Sign-out** from this tab clears the panel before the request. A sign-out or sign-in in another tab is detected on the next focus / visibility check (account hash differs or 401) → clear.
4. **Focus / visibility change** → `GET …/copilot/basis` (no model) → 401 / 404 → clear and say why; other account → clear; digest differs → Outdated.
5. **Not promised:** content the user has already seen, copied, screenshotted or kept on an idle screen that never regains focus cannot be retracted. This is stated in the docs and in the acceptance, not claimed as a pass.

## 5. Validator for the explanation

Model output must be JSON `{ "sentences": [{ "text": string, "facts": ["F3", …] }], "nextStep": "L1" | null }` and pass all of:
1. It parses; size limits hold; every sentence cites ≥ 1 fact id that exists in this bundle.
2. Every number / amount / currency / percentage appears in a cited fact (reusing `src/lib/comparison.ts` / `src/server/extraction/numbers.ts`).
3. State words (Active, Blocked, Ready, Paid, Approved, Answered, Open, …) appear only with a cited fact of that state.
4. No URL, e-mail address, or claim of having acted ("I approved", "payment sent", "I notified the supplier").
5. Every BLOCK finding of the bundle is cited at least once (for `WHY_NOT_APPROVABLE`), so a blocking reason cannot be dropped silently.
6. `nextStep` is one of the server's link ids.

On failure the explanation is dropped and the facts layer stays, with the reason code. **Limit:** passing shows that the sentences are consistent with existing facts. It does not prove that the explanation is semantically right (emphasis, causal links). That needs human review (`docs/copilot-cases.md` §4).

**5.3 Untrusted text.** Excerpts go in a delimited block marked as supplier data. The defence does not depend on the model obeying: the facts are computed before the model is called and independently of it, and the validator rejects numbers and states not in the facts, as well as action claims.

## 6. Calls, budget and migration

### 6.1 One call path

- Same adapter, used through its generic `complete` / `countInputTokens` with a Copilot prompt:
  - `AnthropicExtractionModel` (`maxRetries 0`, no tools, `thinking: between_tools`), approved model list unchanged;
  - adapter selection by `resolveExtractionModel` (no new provider, model or key).
- The ledgered-call logic now private in `ExtractionService` (reserve → call → settle / release / unknown; token-count reservation; unknown outcomes kept counted) is moved into a shared helper. Extraction keeps its exact behaviour; the existing extraction and budget tests guard the refactor (G6).
- **Same global limits** (daily / total amount and calls, shared with extraction). No second budget, no separate limit that could bypass it.
- LIVE Copilot needs **both**:
  - the migration applied (§6.2);
  - an explicit server switch `TRADEPROOF_COPILOT_LIVE=on`, set only for an owner-authorised run.

  Without either, the explanation is MOCK (copy / tests, `AI_PROVIDER=mock`) or absent. A server started with the real `.env.local` and no switch makes **no** Copilot call.
- Calls happen only on a button POST. GET, page load, refresh and focus never call (CP9).
- Copilot limits (proposal):
  - bundle ≤ 12,000 characters (larger → refused, not cut);
  - `max_tokens` 1,000;
  - timeout 60 s;
  - **no retry** (one attempt per ask; a timeout or an error after sending → UNKNOWN, counted).

### 6.2 Ledger migration (gap G1; in the 3–4 Nov scope)

The current `ai_budget_ledger` has `purpose CHECK IN ('QUOTE_EXTRACTION')` and `extraction_id → quote_extraction_runs`. Plan (number = next free at execution, today v18):
- Rebuild `ai_budget_ledger` (SQLite cannot alter a CHECK):
  - `purpose IN ('QUOTE_EXTRACTION', 'COPILOT_ANSWER')`;
  - new nullable `copilot_request_id → procurement_requests(id)`;
  - `CHECK` that `QUOTE_EXTRACTION` rows have the existing shape and `COPILOT_ANSWER` rows have `extraction_id IS NULL AND copilot_request_id IS NOT NULL`;
  - `request_key` for Copilot = `copilot:<server ask id>#1`;
  - triggers `ai_budget_ledger_close_once` (extended to the new column) and `ai_budget_ledger_no_delete` re-created; indexes re-created.
- Procedure as for v14–v17:
  1. backup;
  2. rehearsal on a copy;
  3. restore drill;
  4. apply on the main DB with the dev server stopped;
  5. verify: the 5 existing rows hash-identical (all columns; new column NULL), all other tables row-identical, triggers present, integrity ok, FK 0.
- No answer table: answers are not stored (G4). The ledger row ties cost to a request id, not to answer text.
- Budget visibility unchanged: pages show only "live explanation possible: yes / no + reason".

### 6.3 Duplicates, timeouts, invalid output, unknown cost (same semantics as extraction)

| Case | Handling |
| --- | --- |
| Double click / repeated POST | button disabled while sending; the server keys the ask by idempotency key → same ledger `request_key` → `DUPLICATE`, no second call; the repeat gets "already asked — showing the first result" if it is still in memory, otherwise "already asked; ask again with a new click" (no second charge for the same key) |
| Timeout | ledger UNKNOWN, reservation stays counted; no retry; "Explanation timed out — facts shown" |
| Invalid / failing output | dropped by the validator; tokens settled if reported; facts shown |
| Usage not reported / cost unknown | UNKNOWN + note, reservation counted |
| Budget refused / token count failed | nothing sent; ledger RELEASED or no row (as extraction); facts shown |
| Re-authorisation failed after the call | answer not returned; ledger row closed as in step 5 (§4.2) |

### 6.4 Preparing the real calls (for the owner's authorisation; nothing is called before it)

Delivered on 4 Nov as a short authorisation request:
- **Cases:** about 6 SYNTHETIC asks on a DB copy (proposal: C1 ready, C2 blocked, C4 unknown fees, C5 after reply, I1 injection, C9 no usable run).
- **Count:** the number of model calls and of token-count calls (one count per ask).
- **Cost cap:** the upper bound of each call, from `boundMicros` at the configured prices with the token-count bound, plus a total cap for the run. It must fit inside the existing daily / total limits (spent so far US$0.069710 of the approved US$5 total).
- **What would be recorded:** ledger before / after, each answer's validator result, a human review of the explanations.
- The owner authorises (or changes) the cases, count and cap. Only then is `TRADEPROOF_COPILOT_LIVE` set, for that run only.

## 7. Gaps (status after the owner's decisions)

| # | Gap | Decision / plan |
| --- | --- | --- |
| G1 | Ledger purpose CHECK / FK | **In scope 3–4 Nov:** migration §6.2 |
| G2 | Approval reads write INVALIDATED events | **In scope:** read-only `readFacts` (§2.2) |
| G3 | `readRecordFor` too thin | new fact builder; `policy.ts` unchanged |
| G4 | No answer persistence | kept; revoke cannot retract already-seen text (§4.2.5) |
| G5 | Free text | **decided: buttons only** |
| G6 | Ledgered call private in `ExtractionService` | **in scope:** shared helper; extraction tests guard it |
| G7 | 简体中文 (CP10) | not in 3–4 Nov; 6 Nov polish if time; quoted text always original |
| G8 | Semantic correctness | owner reviews answers; validator ≠ correctness |
| G9 | Digest must include computed validity | included (§2.5) |
| G10 | Re-authorisation after the model returns can fail after money was spent | accepted: the ledger records the spend; the answer is withheld |

## 8. Reuse vs new

**Reused:**
- auth and access: `guard()` / sessions / CSRF, `canReadRequest`, `readRecordFor`;
- facts: `ComparisonService.compare`, `gather` + `evaluateApproval`, `approval-entry.ts`, `ClarificationService.open` / `list`, `ReplyService.view`, `src/lib/replies.ts`, EN labels (`src/i18n/en.ts`);
- model and budget: `resolveExtractionModel`, `AnthropicExtractionModel`, `BudgetStore` + `budget/config.ts`;
- number reading;
- test tooling: the e2e sign-in helper, `seedCase` / `grantTestApprover`.

**New (3–4 Nov):**
- `src/server/copilot/`: `context.ts`, `facts.ts` (facts layer + NEXT_STEP), `links.ts`, `digest.ts`, `prompt.ts`, `validate.ts`, `service.ts` (ask flow §4.2), `mock.ts`, `http.ts`;
- `ApprovalService.readFacts`;
- shared ledgered-call helper;
- ledger migration (next free number);
- routes `POST /api/procurements/[id]/copilot` and `GET /api/procurements/[id]/copilot/basis`;
- `src/app/procurements/[id]/quotes/CopilotPanel.tsx`;
- `tests/copilot.test.ts`, `tests/copilot-migration.test.ts`, `scripts/e2e/copilot.e2e.mjs`.

**No new dependency, no new budget, no answer table.**

## 9. Schedule 3–4 Nov and trade-offs

### 9.1 Plan

| Day | Work | Done when |
| --- | --- | --- |
| **3 Nov** | read-only `readFacts` (G2); fact builder + facts layer for 5 intents + NEXT_STEP + links + digest; ask flow with re-authorisation; validator; MOCK explanation fixtures; routes; unit / HTTP tests; **migration rehearsed on a copy** + migration test | CP1–CP5, CP7, CP9, CP11 automated with MOCK; business tables unchanged by asks; migration rehearsal recorded |
| **4 Nov** | shared ledgered-call helper + LIVE wiring (adapter double, no network); migration applied to the main DB (server stopped, backup + drill); panel (5 buttons, labels, loading / failed / outdated / gone, late-response drop, clear on sign-out / switch, focus check); `copilot.e2e` on a copy; owner check (MOCK + facts); **authorisation request for real calls (§6.4)**; if authorised: the real run on a copy, ledger before / after, human review | CP6 (MOCK), CP8 (ledger with adapter double), CP12; owner check; real-call evidence **only if authorised and run** |

### 9.2 If time runs short — explicit trade-offs (owner decides; nothing dropped silently)

Priority order (top is kept longest):
1. read-only facts + re-authorisation + late-response handling;
2. migration + shared ledgered call (needed for real acceptance);
3. panel with the five buttons;
4. validator + MOCK fixtures;
5. real run (needs authorisation).

Candidates to cut or move, in this order:
- (a) NEXT_STEP alternatives beyond the first step;
- (b) the focus-triggered check, replaced by an explicit "Check" button (the re-check on every ask stays);
- (c) moving the real run and its review to **5 Nov morning**, which shortens deployment preparation that day;
- (d) dropping one or two intents from the real run (not from the build).

**Copilot is not reported as complete while only MOCK has run.** Without an authorised real run it is recorded as "built, MOCK-verified; real acceptance open".

## 10. CP1–CP12 refined (expectations added 1 Nov; ids unchanged)

| CP | Added expectation | Cases |
| --- | --- | --- |
| CP1 | Facts only through `readFacts` / read-only services; same 404; the browser sends only ids + intent | C1–C9, A1, A2, A6, A7 |
| CP2 | Each explanation sentence cites fact ids from this bundle; sources list shows version / revision / run / excerpt / approval ids | C1–C5, I4 |
| CP3 | Amount / eligibility / payment status rendered from facts; a contradicting explanation is dropped | C2, C4, I1, I2 |
| CP4 | Missing basis said plainly; outdated answer marked; no auto re-ask | C8, C9, B1–B5 |
| CP5 | No business write: table hashes identical before / after, incl. computed-invalid approvals (G2); static import test | W1–W3 |
| CP6 | Injection in quote / reply text does not change facts; an explanation following it is rejected (MOCK); one reviewed live sample if authorised | I1–I3, L-run |
| CP7 | No other record's data; re-authorisation before returning; late responses dropped; sign-out / switch clears | A1–A6, R1–R6 |
| CP8 | Purpose `COPILOT_ANSWER` in the same ledger and limits; DUPLICATE / UNKNOWN / RELEASED as extraction; migration keeps existing rows identical | K1–K8, M1–M4 |
| CP9 | No call on load / refresh / focus / basis GET | B5, K1 |
| CP10 | EN first; quoted text original; zh deferred (G7) | — (open) |
| CP11 | Explanations match gate findings, money lists, reply states of the same record | C2, C4, C5 |
| CP12 | Links from the server list only; the target page enforces its own guard | C7, I5 |
