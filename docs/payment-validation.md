# Payment Validation — PayPal Sandbox minimal loop

> Phase: Sandbox payment spike (technical validation only — **not** the procurement approval workflow).
> Last updated: 21 Oct 2026 17:30 (SGT) after the real Sandbox run. Environment: PayPal **Sandbox** only, no Live code path.

Three labels are used strictly:

| Label | Meaning |
| --- | --- |
| **IMPLEMENTED** | Code exists, lint + type-check + build pass |
| **MOCK-TESTED** | Passed automated tests against the labelled MOCK PayPal gateway (`tests/mock-paypal.ts`, simulated responses, no network) |
| **SANDBOX-VERIFIED** | Observed against the real PayPal Sandbox API with real Sandbox accounts |

## 1. Flow under test

```text
/sandbox-demo (127.0.0.1 only)
 └ New test record ─► POST /api/sandbox-demo/records            local record, amount/currency from server catalog (USD 1.00)
 └ PayPal button  ─► POST /api/sandbox-demo/records/:id/order    Orders v2 create, PayPal-Request-Id = record.create_request_id
   buyer logs in on PayPal Sandbox page and approves (JS SDK v6 session)
 └ onApprove      ─► POST /api/sandbox-demo/records/:id/capture  GET order → pre-checks → capture (PayPal-Request-Id = record.capture_request_id)
                                                                  → fresh GET order → verify → PAID / NEEDS_REVIEW / CAPTURE_PENDING / CAPTURE_UNKNOWN
 └ Reconcile      ─► POST /api/sandbox-demo/records/:id/reconcile query PayPal and resolve unknown states (no new order)
```

PAID requires, from a fresh `GET /v2/checkout/orders/{id}`: order id = stored id · `reference_id` and `custom_id` = local record id · exactly one purchase unit · order amount and currency = record · payee `merchant_id` = `PAYPAL_EXPECTED_PAYEE_MERCHANT_ID` · exactly one capture · capture id = id returned by the capture call · capture amount/currency = record · capture `COMPLETED` and order `COMPLETED`. Amounts are compared as integer minor units parsed from PayPal's decimal strings (no floats).

## 2. Status by requirement

| Requirement | IMPLEMENTED | MOCK-TESTED | SANDBOX-VERIFIED |
| --- | --- | --- | --- |
| Server-only PayPal module (`src/server/payments/`, `import "server-only"` entry) | ✅ | n/a | ✅ secret never in page HTML (checked) |
| Amount/currency only from server record; client values ignored | ✅ | ✅ `client tampering is ignored` (+ live HTTP check, §4) | ✅ PayPal order and capture = USD 1.00 from the server record (tampered request **not** sent to PayPal — mock/HTTP only) |
| Create / capture / query bound to local record; no capture of arbitrary order id | ✅ | ✅ 3 tests (+ live HTTP check) | ✅ order `reference_id` = `custom_id` = local record id; capture belongs to that order |
| Pre-capture ownership + content check | ✅ | ✅ | ✅ passed on the real order before capture (no mismatch case tried for real) |
| Post-capture GET verification before PAID | ✅ | ✅ | ✅ app's `VERIFIED_PAID` + 16/16 independent checks (Orders GET + Payments capture GET) |
| Amount / currency / payee / extra-capture mismatch never PAID | ✅ | ✅ 5 cases + PENDING | **mock only** (real payment matched; no real mismatch produced) |
| Same PayPal-Request-Id on retry; create ≠ capture id | ✅ | ✅ | ✅ distinct ids used; **retry with same id: mock only** (no real retry needed) |
| Duplicate requests → one logical payment | ✅ | ✅ | ✅ repeat capture ×2, re-create, reconcile, 5 parallel captures on the **paid** record → all `ALREADY_PAID`; PayPal still 1 capture |
| Concurrent first capture race (two requests before PAID) | ✅ | ✅ 8 concurrent + two DB connections | **mock only** |
| Unknown capture outcome kept, resolved by query, no new order | ✅ | ✅ 3 tests | **mock only** (no real timeout occurred) |
| Retry only inside PayPal's retention window (6 h documented; 5 h used) | ✅ | ✅ 4 tests + migration test | **mock only** |
| Retry window proven on BOTH clocks (local + PayPal `Date` header); future start / lost local time / missing header → NEEDS_REVIEW (added 21 Oct evening, §5a) | ✅ | ✅ 10 tests | partial: PayPal `date` header confirmed present via SDK (read-only GET); no real retry performed |
| Window closed / client error ≠ unpaid | ✅ | ✅ 2 tests | **mock only** |
| Restart recovery from SQLite | ✅ | ✅ 2 tests | ✅ dev server restarted: record, order id, capture id, capture request id unchanged; no new capture |
| Crash mid-capture recovery | ✅ | ✅ | **mock only** |
| "Not configured" shown, no fake success | ✅ | ✅ (+ live HTTP 503) | n/a |
| Sandbox enforced, Live refused | ✅ | ✅ config tests | ✅ calls went to `api-m.sandbox.paypal.com`; JS SDK from `www.sandbox.paypal.com` |
| Local-only API (dev only, loopback Host, same-origin Origin) | ✅ | ✅ (+ live: prod build 404, spoofed Host 403) | ✅ dev server listened on 127.0.0.1 only |
| Real USD 1.00 Sandbox order + capture | ✅ | n/a | ✅ **PASSED 21 Oct 2026** (§5) |
| JS SDK v6 button + PayPal approval window | ✅ | n/a | ✅ owner approved with the Sandbox Personal account; `onApprove` called capture with the matching order id |
| Webhooks | ❌ not in this phase | — | **NOT VERIFIED** (§6) |

## 3. Mock test results (MOCK-TESTED)

Command: `npm test` → `node --test "tests/**/*.test.ts"` (Node 24.19.0, built-in runner, SQLite files in a temp dir).

Result on 21 Oct 2026 (evening): **46 tests, 46 passed, 0 failed** (14 suites). (31 at `9f5e253`; 36 at `24c08f2`; +10 for the clock checks.)

| Suite | Tests | What is simulated |
| --- | --- | --- |
| money (exact minor units) | 1 | decimal-string parsing, rejection of over-precise / malformed values |
| config | 3 | missing vars → names only; `live` env or Live API base refused; secret never in public config |
| happy path | 1 | create → approve → capture → GET → PAID; request ids persisted and distinct; event log |
| client tampering is ignored | 1 | `{amountMinor:1, currency:"JPY"}` and `{amount:"0.01"}` bodies → PayPal still asked for USD 1.00 |
| orders not linked to the local record | 3 | foreign order id from client (409, 0 captures); unknown / malformed ids (404/400); DB linked to a foreign PayPal order → NEEDS_REVIEW, 0 captures |
| duplicate and concurrent requests | 5 | repeat create → same order; 6 concurrent creates → 1 create call; repeat capture → ALREADY_PAID; 8 concurrent captures → 1 capture; 2 SQLite connections racing → 1 capture |
| mismatched PayPal data is never marked PAID | 6 | captured amount 2.00; captured currency EUR; order amount 0.99; payee other merchant; second capture on order; PENDING capture |
| unknown capture outcome | 5 | timeout before processing + lookup failure → CAPTURE_UNKNOWN → reconcile re-captures with the **same** request id, no new order; captured-but-response-lost → PAID with 1 capture; response lost + PayPal unreachable → stays CAPTURE_UNKNOWN; buyer never approved; approved but browser never called capture |
| restart recovery | 2 | PAID record identical after reopen, no second capture; process "dies" mid-capture → after lease expiry the capture resumes with the same request id |
| not configured | 1 | 503 `NOT_CONFIGURED`, record stays NEW |
| local-only guard | 1 | disabled → 404 without touching the DB; non-loopback Host / missing or foreign Origin → 403 |
| database constraints | 2 | schema rejects PAID without capture id; one PayPal order cannot link to two records |
| retry window does not trust the local clock alone | 10 | Date-header parsing; both start times stored (local clock 62.7 min slow); constant offset still allows a legitimate retry; local clock lost 2 h → NEEDS_REVIEW; clock set back → NEEDS_REVIEW; no Date header at retry / at first attempt → NEEDS_REVIEW; read-only reconcile still queries after NEEDS_REVIEW; create retry with future start → not retried; v2 → v3 migration |
| PayPal-Request-Id retention window | 5 | constants (6 h / 5 h); unknown capture > 5 h → NEEDS_REVIEW, no re-capture, start time never reset; retry < 5 h → same request id, PAID; unknown create > 5 h → not retried; v1 DB migrates to v2 keeping records |

Limits of the mock: it reproduces the documented Orders v2 behaviours we rely on (idempotent create/capture by `PayPal-Request-Id`, `ORDER_ALREADY_CAPTURED`, approval), but it is our model of PayPal, not PayPal. Confirmed for real in §5: create/capture happy path, payee merchant id present in the GET order response, one capture per order. Still mock-only: error payloads, retries, retention window.

## 4. Live local checks without credentials (21 Oct 2026)

Run against the real Next.js server on this machine; no PayPal call is possible without credentials.

| Check | Result |
| --- | --- |
| `npm run dev` binds to | `127.0.0.1:3000` only |
| `GET /sandbox-demo` | 200; shows "SANDBOX / DEMO", test item, USD 1.00, "未配置 Not configured" with missing variable names only |
| `POST /records` with tampered body `{"amountMinor":1,"currency":"JPY"}` | 201, record USD 1.00, status NEW |
| `POST /records/:id/order` without credentials | 503 `NOT_CONFIGURED` (no fake success) |
| `POST /records/:id/capture` with foreign `orderId` | 409 `ORDER_MISMATCH` |
| POST without Origin / with cross-site Origin | 403 / 403 |
| GET with spoofed `Host: evil.example` | 403 |
| Dev server restarted → `GET /records/:id` | record and its event log still present |
| Production build (`next start -H 127.0.0.1`) | `/sandbox-demo` and all demo APIs → 404; no database file created |
| Headless Edge screenshot of `/sandbox-demo` | Page renders as described (visual check done for the unconfigured state only) |
| Schema migration on the real local DB (v1 file from phase 1, 1 record) | user_version 1 → 2, record preserved (backup kept in Git-ignored `data/`) |
| `npm run check:sandbox` without `.env.local` | Reports "not found", exit 1; prints no values |

## 5. Real Sandbox test — PASSED (21 Oct 2026, SGT)

Owner filled `.env.local` (values never shown). `npm run check:sandbox`: 4 variables set, format PASS, Sandbox OAuth token obtained from `api-m.sandbox.paypal.com` (HTTP 200, token discarded). Dev server on `127.0.0.1:3000`; page showed "Configured"; the secret value did not appear in the page HTML.

The owner used the existing local test record (created in phase 1 while unconfigured, status `NEW`, USD 1.00 from the server catalog) instead of a new one — no extra record or order was created. The owner logged in with the **Sandbox Personal (buyer)** account and approved; the app captured and verified automatically.

References are masked here; full IDs are only in the Git-ignored `data/evidence/*.json` (redacted: no payer, payment source, shipping, payee e-mail, links, tokens).

| Field | Value |
| --- | --- |
| Local record | `tp_29e1…5ceb` |
| PayPal order | `1BX0…8634` — intent CAPTURE, status **COMPLETED** |
| PayPal capture | `9AN9…5947` — status **COMPLETED**, `final_capture` true |
| Amount | **USD 1.00** (order and capture) |
| Payee | merchant id = `PAYPAL_EXPECTED_PAYEE_MERCHANT_ID` (`…3AVG`) |
| Captures on the order | **1 total, 1 COMPLETED** |
| PayPal-Request-Ids | create `5681…ff1f`, capture `87b2…e412` (distinct; each used once) |
| App event log (UTC) | 09:21:59 CREATE_ATTEMPT → 09:22:01 ORDER_CREATED → 09:23:46 CAPTURE_ATTEMPT → 09:23:48 CAPTURE_RESPONSE (COMPLETED) → 09:23:49 VERIFIED_PAID |

### Independent verification (separate script, SDK directly, not the app's verify code)

Orders `GET /v2/checkout/orders/{id}` + Payments `GET /v2/payments/captures/{id}`; 16 checks: order id = record's, order COMPLETED, intent CAPTURE, 1 purchase unit, `reference_id` and `custom_id` = record id, order amount USD 1.00, payee merchant id = expected, exactly 1 capture, exactly 1 COMPLETED capture, capture id = record's, capture COMPLETED, capture USD 1.00, capture's related order id = record's order, `final_capture` true, capture `custom_id`/`invoice_id` = record id.

| Query time (UTC / SGT) | When | Result |
| --- | --- | --- |
| 2026-10-21 09:25:55 / 17:25:55 | after payment | **16/16 PASS** |
| 2026-10-21 09:26:55 / 17:26:55 | after dev-server restart and repeat requests | **16/16 PASS**, same order id and capture id, still 1 capture |

### Repeat operations on the same paid record (real server, no new purchase)

| Step | Before restart (09:26:23 UTC) | After restart (09:26:48 UTC) |
| --- | --- | --- |
| Page reload | 200, shows PAID + same order id | 200, shows PAID + same order id |
| Capture again with `{orderId}` | 200 `ALREADY_PAID` | 200 `ALREADY_PAID` |
| Capture again, no body | 200 `ALREADY_PAID` | 200 `ALREADY_PAID` |
| Create order again | 200 `ALREADY_PAID` (no PayPal create) | same |
| Reconcile (server GET to PayPal, re-verify) | 200 `ALREADY_PAID` ("still paid") | same |
| 5 parallel capture requests | 5 × `ALREADY_PAID` | 5 × `ALREADY_PAID` |
| PayPal-side attempts in event log | CREATE_ATTEMPT 1, CAPTURE_ATTEMPT 1 | CREATE_ATTEMPT 1, CAPTURE_ATTEMPT 1 |
| Order / capture / capture request id | unchanged | unchanged |

Note: parallel requests hit an already PAID record, so they exercise the PAID short-circuit, not the first-capture race (that race is **mock-tested only**).

### Observations

- ~~PayPal Sandbox clock / time-zone handling~~ — **corrected 21 Oct 2026 (§5a):** the ≈ 1 h gap was this machine's clock running 62.7 min slow, not PayPal. All local timestamps in this section (event log, `paidAt`, evidence `queriedAt`, query times above) are on that slow clock; true UTC ≈ local + 3,762.7 s. They are kept as recorded, not rewritten.
- The record's event log also contains a `CAPTURE_REJECTED_ORDER_MISMATCH` event from the phase-1 live HTTP check (foreign order id sent before any PayPal order existed) — expected.
- No code change was needed during the real run.

## 5a. Time discrepancy investigation (21 Oct 2026, evening)

Question: why does PayPal's capture `create_time` differ from our local log by ≈ 1 h, and can it cause an unsafe automatic retry? Sources: saved evidence files and DB (no new order, no capture); one extra **read-only** GET of the existing order; Windows System event log; HTTP `Date` headers.

### Same event compared: the capture

PayPal's order `create_time` / `update_time` are also 10:26:30Z (identical to the capture), so they do **not** represent order creation and are not compared with our ORDER_CREATED.

| Source (same capture event) | Raw value | UTC | Asia/Singapore | vs PayPal |
| --- | --- | --- | --- | --- |
| PayPal capture `create_time` (Orders GET and Payments capture GET; SDK passes the string through) | `2026-10-21T10:26:30Z` | 10:26:30 | 18:26:30 | — |
| Local CAPTURE_ATTEMPT (request sent; DB, `toISOString()`) | `2026-10-21T09:23:46.370Z` | 09:23:46.370 (local clock) | 17:23:46 | −3,763.6 s |
| Local CAPTURE_RESPONSE (response received) | `2026-10-21T09:23:48.424Z` | 09:23:48.424 (local clock) | 17:23:48 | −3,761.6 s |
| Local times + measured offset 3,762.7 s | — | 10:26:29.1 → 10:26:31.1 | 18:26:29 → 18:26:31 | PayPal's 10:26:30 lies **inside** the corrected send→response interval |

All strings carry `Z`; storage is `Date.toISOString()` (UTC), display is one `toLocaleString()` conversion; no fixed offsets, no removed `Z`. Windows time zone: Singapore Standard Time (UTC+8, no DST); Node resolves `Asia/Singapore`, offset +480 min. The gap is **1 h 02 m 42 s**, not a whole hour — a time-zone/DST error would be a whole-hour multiple.

### Evidence that the local clock was slow, also at payment time

| Evidence | Result |
| --- | --- |
| HTTP `Date` vs local clock now (PayPal API, PayPal web, Microsoft, Cloudflare) | server − local = **+3,762.3 … +3,763.3 s** on all four; repeated 3× over 40 s: stable (±0.5 s, header resolution 1 s) → normal clock rate, constant offset |
| Read-only GET of the existing order through the SDK | `date` header present; +3,763.3 s; order unchanged (COMPLETED, 1 capture) |
| Windows time service (`w32tm /query /status`) | Leap indicator 3 (not synchronised); source **Local CMOS Clock**; last sync error "no time data available"; ≈ 3,830 s since last good sync |
| System log, Kernel-General ID 1 (system time changes) | last change at local 16:43:38 (08:09:40Z → 08:43:38Z, +34 min, by the time service); **no time change after it** — i.e. none between the payment and the measurements |
| Same log, previous days | repeated large **forward** corrections (+31 min, +52 min, +3 h 06 m, +8 h): this machine's clock regularly falls behind and is later stepped forward |
| Power events after 16:43:38 local | none (no sleep / standby / resume) |
| Offset implied at capture vs offset now | 3,761.6–3,763.6 s vs 3,762.7 s → same constant offset |

**Conclusion:** PayPal's timestamp is correct; this machine's wall clock was ≈ 62.7 min slow during the transaction and still is. Supported by: no clock step between the payment and the measurements, the identical offset, and PayPal's own `Date` header agreeing with Microsoft and Cloudflare. **Not explained:** why the clock was still ≈ 63 min slow right after the 16:43:38 time-service correction (no later steps or power events were logged), and why the time service now has no time source. Reading the full time-service configuration needs administrator rights and was not done. The machine is a physical Alienware x14 (not a VM guest).

### Impact on the automatic retry window — defect found and fixed

Code path before the fix: request-id start times = local `Date.now()` stored before the PayPal call (set once); window check = local `now − start ≤ 5 h`; PayPal timestamps never used; after a restart the same stored local times are compared with the local clock.

| Case | Before | After |
| --- | --- | --- |
| Constant offset (this transaction) | no effect (offset cancels); the real payment used each request id once, ~2 s apart, no retry | unchanged |
| Missing / invalid start time | not provable → manual review | unchanged |
| Start time in the future (clock set back) | negative elapsed counted as **inside** the window | **not provable → NEEDS_REVIEW** (tolerance 60 s) |
| Local clock **loses** time between first attempt and retry (observed behaviour of this machine, up to hours) | elapsed understated by the lost time → retry possibly **after** PayPal's 6 h retention | capture retry also requires PayPal's clock: `Date` header of the GET just before the first capture (stored, set once, schema v3) vs `Date` header of the GET at retry; both clocks must be inside 5 h, otherwise **NEEDS_REVIEW** |
| PayPal `Date` missing at either point | — | not provable → NEEDS_REVIEW |
| Clock stepped forward (e.g. when it is finally synced, +62.7 min) | elapsed overstated → fewer retries (safe) | same |
| Create retry (no PayPal response exists before the first create) | local clock only | local clock only, plus the future-start check; residual risk is an extra **unapproved** order, which cannot be paid through this app |
| Record in NEEDS_REVIEW | read-only reconcile works | unchanged (tested) |

Independent backstop (not relied on): an Orders v2 order with intent CAPTURE can be captured once; a second capture returns `ORDER_ALREADY_CAPTURED`, which the app turns into a verify, not a new capture.

Display: the page's "Verified paid at 17:23:49" (SGT) is a correct conversion of the stored value, but the stored value came from the slow clock (true ≈ 18:26:32 SGT). Raw values are kept; no retroactive correction.

## 6. Webhooks — not in this phase, NOT VERIFIED

This phase confirms payments by **server-side GET of the order** only. No public tunnel or deployment was created; **public webhook delivery was not tested**. Next phase:

1. Register a webhook on the Sandbox app for `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`; store `PAYPAL_WEBHOOK_ID` in `.env.local`.
2. Signature verification: `POST /v1/notifications/verify-webhook-signature` with the `paypal-transmission-*` / `paypal-auth-algo` / `paypal-cert-url` headers, `webhook_id` and the raw body; accept only `SUCCESS`.
3. Deduplication: table of processed `event.id` (UNIQUE); a duplicate delivery is acknowledged and ignored.
4. State updates: webhook only *triggers* the existing `reconcile` (GET + verify); it never marks PAID from the event body alone, never creates orders, and handles out-of-order events (e.g. PENDING after COMPLETED).
5. Delivery needs a public HTTPS URL (tunnel or hosted preview) — decision and cost check required first.

## 7. Not implemented / not verified

- Webhooks (§6).
- **Mock-tested only (not reproduced against real PayPal):** first-capture race between concurrent requests, capture timeout / unknown outcome and reconciliation, retry with the same `PayPal-Request-Id`, retention-window cut-off, crash mid-capture, buyer closing the window, amount / currency / payee mismatch handling, PENDING captures, `ORDER_ALREADY_CAPTURED` handling.
- APIMatic context plugin loaded for one session via `--plugin-dir` — not yet attempted.
- **This machine's clock** is ≈ 62.7 min slow and the Windows time service currently has no time source (§5a). Root cause not determined (needs administrator access). Until fixed, local timestamps in logs and the UI are ≈ 1 h early.
- Authentication / authorisation: there is **no user login or permission system**; the demo is protected only by being development-only and loopback-only. Not suitable for deployment.
- Refunds, partial captures, multiple items, currencies other than USD.
- Procurement approval before payment (the demo pays a fixed test item directly).
- PayPal's idempotency retention: the Orders v2 spec states 6 hours (extendable to 72 h via an account manager); the app retries automatically only within 5 h and otherwise hands over to manual review. The real expiry behaviour was not tested.

## 8. Approval payments — MOCK tests, plus one historical real Sandbox run

Payments of in-app approvals reuse this module (`docs/approval-design.md` §15–16). Most evidence below is MOCK; **one**
payment ran against the real PayPal Sandbox, on 30 Oct 2026, on the development version of that day. Each row names its
environment and the version it ran on; the rows are kept apart and do not add up to "verified in the real Sandbox" for
any later version. Development commits are from the author's local history (the public repository is a single-commit
export, so they cannot be looked up there).

| Evidence | What it covers | Environment | Version / date |
| --- | --- | --- | --- |
| Unit tests `tests/approval-payment.test.ts` + payment part of `tests/approval.test.ts` | valid → PAID; invalid / revoked refused; tampering; basis change between order and capture; parallel requests; unknown capture / create outcomes never re-sent; restart recovery; switch rules; MOCK gateway | **MOCK** gateway (no network) | written 30 Oct 2026 (12 + 5 tests at that time); re-run with every later change |
| Unit tests: capture race after an unknown outcome (V1, V4 — deterministic gate) | request A waits for its pre-capture order lookup while request B's capture ends with an unknown outcome; A must send nothing (one capture request in total); unknown stays unknown, a read-only check records a capture PayPal shows | **MOCK** gateway (no network) | added 10 Nov 2026 with the fix; **not run against the real Sandbox** |
| Browser `npm run e2e:approval-pay` on a DB **copy** (MOCK mode): 11/11, then 5/5 after a dev-server restart | page flow: approve → record → order → simulated buyer approval → capture (double clicks) → PAID; invalid after order; unknown capture; reload / restart | **MOCK**, no PayPal request | first 30 Oct 2026; re-run on later release candidates (e.g. 9 and 10 Nov 2026) |
| Local HTTP probe on the main DB, switch off | 4 payment steps → 409 `PAYMENTS_NOT_ENABLED`; MOCK route 404; DB unchanged | no PayPal call | 30 Oct 2026 |
| Real Sandbox payment of an approval | PR-F9B23762, USD 12.00 (authorised by the owner): owner saw PAID; app VERIFIED_PAID; independent Orders GET + capture GET 17/17; repeats reused the record; restart kept it | **real PayPal Sandbox — one run** (extraction in that record was MOCK) | 30 Oct 2026, evening; development commit `fce6dc9`. **Not repeated** on later versions (for example the approver-grant fix of 31 Oct 2026 or the capture-race fix of 10 Nov 2026) |

Until the owner's authorisation on 30 Oct evening no PayPal request was made that day. The authorised run then made: token(s), 1 create, 1 capture, order GETs (app 2, independent 1, reconcile 1) and 1 capture GET (independent). Details: `docs/setup-status.md` "30 Oct 2026 (evening) — real PayPal Sandbox payment".
