# Dependency advisory: follow-redirects GHSA-mrwp-f3q8-3g9p (9 Nov 2026, SGT)

**Result:** fixed by pinning the patched version through an npm override (`follow-redirects` 1.16.1 → **1.16.2**).
No other package changed. `npm audit --omit=dev`: 0 vulnerabilities after the fix. Analysis below: the trigger
condition is not met by TradeProof's code paths (by code reading plus a loopback test), but this was **not** proven
against the real PayPal Sandbox (no Sandbox call was made for this check).

## 1. What was installed

| Item | Value |
| --- | --- |
| Package | `follow-redirects` **1.16.1** (transitive; not a direct dependency) |
| Path | `tradeproof` → `@paypal/paypal-server-sdk@2.5.0` → `@apimatic/axios-client-adapter@0.3.21` → `axios@1.20.0` → `follow-redirects@1.16.1` |
| Declared range in axios 1.20.0 | `^1.16.0` |

## 2. Advisory (official sources)

| Item | Value |
| --- | --- |
| ID | GHSA-mrwp-f3q8-3g9p · CVE-2026-116689 · CWE-201 (insertion of sensitive information into sent data) |
| Sources | GitHub advisory database (`github.com/advisories/GHSA-mrwp-f3q8-3g9p`), the maintainer's repository advisory, NVD entry, fix commit `b0a7751e9cd64cd8eeb6ec67d2f206a9cc88d3f8`, release `v1.16.2` |
| Severity | GitHub "high"; CVSS 3.1 **5.9** (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N); CVSS 4.0 8.2 |
| Affected | `>= 1.16.0, <= 1.16.1` |
| First patched | **1.16.2** (published to npm 2026-10-25) |
| Published | 2026-10-30 |

**Trigger (from the advisory):** the caller passes the `sensitiveHeaders` option as an array created in **another
JavaScript realm** (e.g. `node:vm`), lists a **custom credential header** in it, and the request meets an attacker-
controlled or compromised endpoint that answers with a **cross-origin redirect**. 1.16.1 checks the option with
`instanceof Array`, so a cross-realm array is silently replaced by an empty list and the custom header is forwarded.
Built-in `Authorization`, `Proxy-Authorization` and `Cookie` stripping stays effective. The advisory reports that
axios 1.20.0 + follow-redirects 1.16.1 did **not** reproduce (axios normalises the option).

The code change from 1.16.1 to 1.16.2 (checked with `npm diff`) is exactly that check: `isArray(…)` (`instanceof
Array`) → `Array.isArray(…)`; plus a README notice that maintenance is paused for lack of funding.

## 3. Exposure in TradeProof

| Path | Uses follow-redirects? | Trigger possible? |
| --- | --- | --- |
| MOCK mode (`mock:*`, demo, video) | **No request at all**: MOCK payments use a local JSON file; no PayPal SDK request is made (the SDK module is imported, but follow-redirects only runs when an HTTP request is sent) | no |
| Real PayPal Sandbox (`TRADEPROOF_APPROVAL_PAYMENTS=sandbox`, own keys) | **Yes**: the SDK's axios adapter does not set `maxRedirects`, so axios uses its follow-redirects transport for requests to the Sandbox API | not by our code: TradeProof never sets `sensitiveHeaders`; axios sets it itself to a same-realm empty array (`axios/lib/adapters/http.js`); the credential header is `Authorization` (OAuth Basic / Bearer), which follow-redirects strips on cross-origin redirects in both versions; `PayPal-Request-Id` (idempotency key) is not a credential |
| Claude API (`@anthropic-ai/sdk`) | No (uses `fetch`, not axios) | no |

**Loopback test** (`127.0.0.1` server → 302 → `localhost` server on another port; fresh headers per request;
`Authorization`, `PayPal-Request-Id`, a custom `X-Svc-Cred`, and a harmless header):

| Case | 1.16.1 | 1.16.2 |
| --- | --- | --- |
| follow-redirects, cross-realm `sensitiveHeaders: ["X-Svc-Cred"]` (advisory trigger) | custom credential **forwarded** | stripped |
| follow-redirects, same-realm list | stripped | stripped |
| axios defaults (the SDK adapter's path) | `Authorization` stripped; custom header forwarded (none is listed — expected behaviour, not this advisory) | same |
| axios with a cross-realm `sensitiveHeaders` config | stripped (axios normalises) | stripped |

**Not established:** behaviour against the real Sandbox endpoint (no call made); the exact headers the APIMatic
adapter adds at run time (read from code, not captured); whether PayPal's API ever answers with a cross-origin
redirect. None of these is needed for the advisory's trigger, which requires a cross-realm `sensitiveHeaders` array
that TradeProof's code never creates.

## 4. Fix

- `package.json`: `"overrides": { "follow-redirects": "1.16.2" }`. Compatible: axios 1.20.0 declares `^1.16.0`, so
  1.16.2 is inside the range the dependent package already accepts; the override only pins it. 1.16.2 was chosen over
  1.16.3 (published 2026-11-08) because it is the advisory's patched version and has been public for two weeks.
- `package-lock.json`: one entry changed (`node_modules/follow-redirects` version, resolved URL, integrity =
  registry `dist.integrity`). No other package added, removed or changed.
- Verified: `npm ls follow-redirects` → `1.16.2 overridden`; `npm audit --omit=dev` → 0 vulnerabilities.
- Not used: `npm audit fix --force`; no upgrade of Next.js, axios, the PayPal SDK or anything else. No payment code
  changed.

**Remaining (development only, unchanged):** `npm audit` including dev dependencies reports a moderate `minimatch`
advisory (GHSA-g3hv-75wg-m249) inside the ESLint toolchain (`eslint-config-next` → `typescript-eslint`). npm's only
offered fix is a breaking downgrade of `eslint-config-next`; not applied. It affects linting, not the app.
