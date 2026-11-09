# PayPal Sandbox Payment Plan (minimal verification)

> Status 21 Oct 2026: **implemented and mock-tested; real Sandbox run pending owner credentials.** Evidence and results: `docs/payment-validation.md`.
> Environment: **Sandbox only** (`https://api-m.sandbox.paypal.com`). There is no Live code path.

## 1. Accounts (one fixed supplier, one buyer)

| Role in TradeProof | PayPal Sandbox account | Notes |
| --- | --- | --- |
| **Test supplier = payee / merchant** | Your **default Sandbox Business account** | Receives the money. Its Account ID goes into `PAYPAL_EXPECTED_PAYEE_MERCHANT_ID`; a capture is only PAID if PayPal reports this payee. |
| **REST app owner** | The **same Sandbox Business account** | Reuse the existing *Default Application* (or an existing app) if it belongs to this Business account. By default money is paid to the app owner, so no payee override is sent. |
| **Test buyer = payer** | Your **default Sandbox Personal account** (a different account) | Logs in on the PayPal Sandbox approval window. |
| Internal approver | Not a PayPal account | Out of scope for this phase (no procurement approval yet). |

Not assumed: paying arbitrary third-party suppliers (payee override / Multiparty needs partner approval) and "buyer approved in PayPal" = "company approved the purchase".

## 2. Technology decisions (verified 21 Oct 2026)

| Item | Decision | Evidence |
| --- | --- | --- |
| Server SDK | `@paypal/paypal-server-sdk` **2.5.0**, pinned exact (MIT). `Client` + `Environment.Sandbox` + `OrdersController.createOrder / getOrder / captureOrder` | npm registry (latest 2.5.0, 2026-08-21); repo `paypal/PayPal-TypeScript-Server-SDK` HEAD `b02a9b9`; SDK source in `node_modules` |
| PayPal-Request-Id | Passed explicitly as `paypalRequestId`. **The SDK does not generate one** — it only sets the header when the argument is given (`src/controllers/ordersController.ts`) | SDK source |
| Timeouts / retries | SDK default `timeout: 0` (none) and `maxNumberOfRetries: 0`, POST not in `httpMethodsToRetry` (`src/defaultConfiguration.ts`). We set timeout 20 s, retries 0; retries happen in our code with the same request id | SDK source; APIMatic skill `typescript-configuration-resilience` |
| Browser SDK | **PayPal JavaScript SDK v6**: `https://www.sandbox.paypal.com/web-sdk/v6/core`, `paypal.createInstance({ clientId, components: ["paypal-payments"] })`, `findEligibleMethods()`, `createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })`, `<paypal-button>`, `session.start({ presentationMode: "auto" }, Promise<{ orderId }>)`. No v5 (`/sdk/js`) code | developer.paypal.com/checkout/integrate and /sdk/js/set-up (page updated 13 Oct 2026) |
| Persistence | Node built-in `node:sqlite` (no native addon, nothing for npm `allowScripts` to block). File `data/sandbox-payments.sqlite`, Git-ignored | Node ≥ 22.13 unflagged; tested on 24.19.0 |
| Node minimum | Raised from 20.9 to **22.18** (`node:sqlite` + running TypeScript tests without flags); `@types/node` → `^22` | package.json `engines` |
| REST fallback | Not needed: no SDK blocker found | — |

### Claude Code plugins (development helpers only)

| Plugin | Status this phase |
| --- | --- |
| **APIMatic context plugin** `paypaldev/server-sdk-context-plugin-preview` @ `6aa0571` (plugin name `paypal`, v0.1.0, preview) | **Not installed.** Its installer `context-plugins@0.12.0` (reviewed from the npm tarball README) always runs `claude plugin install … --scope user`, writes `~/.context-plugins/` and sends anonymous Mixpanel telemetry — a **user-level change**, so not done without the owner's confirmation. Plugin manifest passed `claude plugin validate` (1 warning: no icon). It was **not loaded** as a plugin in the coding session. Its TypeScript skill files were **read as documentation** and directly informed: explicit `timeout`, retry defaults, `ApiError` / `CustomError` payload shape. Project-scoped alternative with no config change: start Claude Code with `--plugin-dir <cloned plugin folder>` for one session. |
| **PayPal AI-Toolkit** `paypal/AI-Toolkit` @ `1401791` (plugin `paypal@1.2.0`) | Not installed / not loaded (same plugin name `paypal`; not loading both). Template remains in `config/claude-project-settings.json`. |

## 3. Implemented sequence (Orders v2, intent CAPTURE)

```text
Browser (/sandbox-demo)        Next.js route handlers (127.0.0.1)                     PayPal Sandbox
New test record ──────────────► create record: USD 1.00 from server catalog,
                                 create_request_id = UUID (persisted)
PayPal button click ──────────► POST …/order: CAS NEW→ORDER_CREATING (lease)
                                 createOrder(reference_id=custom_id=invoice_id=record id,
                                 amount from record, PayPal-Request-Id=create_request_id) ─► CREATED
                                 store order id → ORDER_CREATED   ◄──────────────────────── order id
buyer approves in PayPal window ────────────────────────────────────────────────────────► APPROVED
onApprove({orderId}) ─────────► POST …/capture {orderId only cross-checked}
                                 GET order → must be this record's order, amount, payee, APPROVED
                                 CAS ORDER_CREATED→CAPTURING, capture_request_id = UUID (COALESCE: reused on retry)
                                 captureOrder(PayPal-Request-Id=capture_request_id) ─────────► capture
                                 fresh GET order → verify all fields → PAID | NEEDS_REVIEW | CAPTURE_PENDING
                                 timeout / 5xx → CAPTURE_UNKNOWN → GET → reconcile (same request id, no new order)
```

Record states: `NEW → ORDER_CREATING → ORDER_CREATED → CAPTURING → PAID`, plus `CAPTURE_UNKNOWN`, `CAPTURE_PENDING`, `NEEDS_REVIEW`, `FAILED`. Every change is a conditional `UPDATE … WHERE status IN (…)`; DB `CHECK` and `UNIQUE` constraints reject PAID without capture id and one PayPal order linked to two records. An event log (`sandbox_payment_events`) records each step without secrets.

## 4. Verification before PAID

See `docs/payment-validation.md` §1. Any mismatch → `NEEDS_REVIEW`, never silently fixed and never re-captured.

## 5. Preventing duplicate payments

| Layer | Mechanism |
| --- | --- |
| UI | Button only for payable states (cosmetic only) |
| Server, create | One order per record (existing order returned); CAS + lease; same `PayPal-Request-Id` on retry |
| Server, capture | Capture only via the record's stored order id; CAS + lease; one persisted capture request id reused on every retry; `ORDER_ALREADY_CAPTURED` → verify instead of capture; PAID → no call |
| Database | `UNIQUE(paypal_order_id)`, `UNIQUE(paypal_capture_id)`, `UNIQUE(create_request_id)`, `UNIQUE(capture_request_id)`, `CHECK` on PAID |
| PayPal | Idempotency on `PayPal-Request-Id` (retention period not stated in the docs); an order can only be captured once |

If PayPal ever failed to deduplicate a retried *create*, the extra order would stay unapproved and uncapturable through this app (the record links one order only), so no extra money moves.

## 6. Credentials and local config (you do this; never paste values in chat)

1. Sign in at <https://developer.paypal.com/dashboard/> and make sure the **Sandbox** toggle is on.
2. **Testing Tools → Sandbox Accounts**: identify the default **Business** account (supplier) and the default **Personal** account (buyer). Open the Business account (**View/Edit Account**) and note its **Account ID** (13 letters/digits) — that is the merchant ID. Open the Personal account to see/reset its Sandbox password; you use it only on the PayPal Sandbox login window.
3. **Apps & Credentials** (Sandbox): open the existing *Default Application* (or your existing app) and check it belongs to that Business account. Copy its **Client ID** and **Secret** (Show).
4. In the project folder: `copy .env.example .env.local`, open `.env.local` in an editor, fill `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_EXPECTED_PAYEE_MERCHANT_ID`. Keep `PAYPAL_ENVIRONMENT=sandbox`. Save.
5. Check it is ignored: `git check-ignore .env.local` must print `.env.local`.
6. `npm run dev`, open <http://127.0.0.1:3000/sandbox-demo>.

## 7. Webhooks

Next phase — see `docs/payment-validation.md` §6. Not verified in this phase.

## Sources

- TypeScript Server SDK: <https://github.com/paypal/PayPal-TypeScript-Server-SDK> and `@paypal/paypal-server-sdk@2.5.0` source
- APIMatic context plugin: <https://github.com/paypaldev/server-sdk-context-plugin-preview>; installer `context-plugins@0.12.0` (npm)
- AI-Toolkit: <https://github.com/paypal/AI-Toolkit>
- Checkout quickstart (JS SDK v6): <https://developer.paypal.com/checkout/integrate>, setup <https://developer.paypal.com/sdk/js/set-up>
- Idempotency: <https://developer.paypal.com/api/rest/reference/idempotency/> (same id → latest status of the earlier request, no duplicate action; simultaneous requests with the same id may fail; create and capture need different ids)
- Orders v2: <https://developer.paypal.com/docs/api/orders/v2/>
- Sandbox accounts: <https://developer.paypal.com/tools/sandbox/accounts/>
- Webhooks: <https://developer.paypal.com/api/rest/webhooks/>
