# TradeProof

**Cross-border procurement review and payment assistant · 跨境采购审核与付款助手**
Built for the PayPal AI Hackathon (2026).

**What you will run:** the recommended local run — and the demo video — use **MOCK mode**: simulated PayPal and
canned AI output, no API keys, no external calls. With your own keys, TradeProof can also call a real Anthropic
Claude model and the real PayPal **Sandbox** (see [Modes at a glance](#modes-at-a-glance)). Payments are PayPal
Sandbox only: no real money and no PayPal **Live** (production) code path.

> Demo video: `<YouTube link — to be added after upload>` · Licence: [MIT](LICENSE) · Third-party notices:
> [`docs/credits.md`](docs/credits.md)

## The problem

A small business that orders samples or small batches from an overseas supplier gets quotes in Chinese, English or
both. The quote often differs from what was asked for (quantity, material, finish, fees, payment terms), the
differences are easy to miss in chat, and the payment that follows is not tied to what anyone actually checked and
approved. When something goes wrong, nobody can show which quote, which conditions and which approval the money was
paid for.

## Who it is for (first version — a hypothesis, not market research)

A **small-business buyer** who buys **samples, customised goods or small batches** from a **small overseas supplier
that accepts PayPal**, plus the **approver** (owner or finance lead) who must sign off before money moves. No user
research has been done yet; this is the customer I designed for and want to test with.

## What TradeProof does

> Purchase request → quote versions → AI extraction with sources → buyer review → deterministic comparison →
> bilingual clarification → supplier reply tracking → human approval of exact conditions → PayPal Sandbox payment of
> exactly the approved amount → traceable record

**AI reads and explains. People review and approve. Deterministic code decides the approval state, the amount and
the payment.**

| Step | What happens | Who decides |
| --- | --- | --- |
| Request | Items, specification, quantity, budget, ship date, accepted payment terms; every edit is a revision | Buyer |
| Quote | Supplier quote pasted as text and kept as an **immutable version** (with a snapshot of the request it answered) | Buyer |
| Extraction | An AI model (or a labelled MOCK) proposes values, each with a verbatim source excerpt. A value is **kept only if its excerpt is found in this quote version's text** (for verbatim facts, with the value inside it); fields the quote does not state stay **unknown**; values with a missing, unmatched or unreadable excerpt are not saved as facts and the run is marked incomplete | AI proposes |
| Review | The buyer confirms or corrects each value, one by one; nothing counts until reviewed | Buyer |
| Comparison | Deterministic comparison with the request; unknown fees stay **unknown, never 0** | Code |
| Clarification | Bilingual EN / 简体中文 questions from fixed templates with a deterministic per-question check; nothing is sent automatically | Buyer |
| Replies | Supplier replies are stored as replies (not quote versions); the buyer records which question each answers | Buyer |
| Approval | An approval snapshot binds **one quote version, one extraction run and the reviewed conditions**; only an approver the buyer assigned can approve; it stops being valid when something it was based on changes — e.g. a request revision that changes the compared request content, a newer quote version, changed reviews or requirement classifications, or removal of the approver's assignment (editing only the title does not) | Approver |
| Payment | PayPal Orders v2: the server creates the order for the approved USD amount to one fixed Sandbox merchant, captures it and verifies the result server-side | Buyer starts, code checks |
| Copilot | Five fixed buttons (no free text) that explain TradeProof's own stored facts with sources, in English; it cannot approve, pay or change data | Explains only |

## Architecture

- **Next.js 16 (App Router), React 19, TypeScript.** Pages and API routes in `src/app/`; all business logic in
  server-only modules under `src/server/` (procurement, quotes, extraction, comparison, clarification, replies,
  approval, payments, copilot, budget, auth, access).
- **SQLite** through Node's built-in `node:sqlite` (schema v18, forward migrations with automatic backups);
  append-only tables for reviews, approval events and payment events.
- **AI:** Anthropic Claude (`@anthropic-ai/sdk`; model used in the recorded real runs: `claude-sonnet-5-5`) for
  quote extraction and Copilot explanations. Every real call is reserved and settled in a local **budget ledger**
  with per-day and total limits; model output is checked before it counts: an extracted value is kept as a fact
  only if its excerpt is found in the quote text (values that fail stay visible, marked as not saved), and a Copilot
  answer that fails its checks against stored facts is not shown.
- **PayPal:** `@paypal/paypal-server-sdk` (Orders v2: create, capture, server-side GET verification). An unknown
  PayPal result is treated as neither success nor failure: it is recorded and checked by reading PayPal first. A
  capture whose result is unknown is never sent again; an order creation with an unknown result is not retried
  automatically — the buyer may repeat it with the same `PayPal-Request-Id`, and only within 5 hours of the first
  attempt (PayPal keeps request ids for 6 hours).
- **Access:** preset local accounts (username + password, scrypt hashes), server sessions, CSRF protection,
  per-request ownership and approver grants checked on every page and API.
- **Safe MOCK mode** (`scripts/local-mock.mjs`): separate database, MOCK extraction, MOCK Copilot answers, simulated
  PayPal; refuses to start if a real model, real payments or the main database would be used.

## Run it locally (MOCK mode — no API keys, no external calls)

Supported way to run: the **local development server** started by `mock:start` (or `npm run dev`, see below).
Requirements: **Node.js 22.18 or newer** (verified with Node 24.19.0 / npm 11.17.0 on Windows 11), Git, a browser.

**Windows PowerShell** (use `npm.cmd`; PowerShell may block the `npm.ps1` shim):

```powershell
git clone <repository-url> TradeProof
cd TradeProof
npm.cmd ci
npm.cmd run mock:accounts     # creates buyer-a, buyer-b, approver; type each password twice (hidden, min 12 chars)
npm.cmd run mock:seed-base    # optional: one SYNTHETIC request + quote + MOCK extraction run, nothing reviewed
npm.cmd run mock:start        # http://127.0.0.1:3000 — stop with Ctrl+C
npm.cmd run mock:close        # after stopping: checkpoint and close the MOCK database
```

**Git Bash / macOS / Linux shells** (same commands with `npm`; only Windows was tested):

```bash
git clone <repository-url> TradeProof
cd TradeProof
npm ci
npm run mock:accounts
npm run mock:seed-base
npm run mock:start
npm run mock:close
```

You choose the three passwords yourself when you run `mock:accounts`; there are no shared test credentials and no
API keys are needed. `mock:*` commands always use a separate MOCK database (`data/mock/tradeproof-mock.sqlite`,
Git-ignored) and override any values in `.env.local`.

**Production serving is not supported.** `npm run build` succeeds, but `npm start` deliberately serves only the
landing page: sign-in, every procurement page and every API answer 404 (`src/proxy.ts` refuses production and
non-loopback hosts by design). There is no hosted demo.

Full instructions — roles, demo data, tests, browser checks, stopping, real-service configuration, troubleshooting —
are in **[`docs/run-guide.md`](docs/run-guide.md)**.

### Modes at a glance

| How you start | Database | Extraction | Copilot | Payments |
| --- | --- | --- | --- | --- |
| `npm run mock:start` (recommended) | MOCK file (`data/mock/…`) | MOCK | MOCK | MOCK (simulated) |
| `npm run dev` with **no** `.env.local` | main file `data/sandbox-payments.sqlite` | not configured | facts only, no explanation | off |
| `npm run dev` with your own filled `.env.local` | main file | real model (counts against the budget ledger) | real only if `TRADEPROOF_COPILOT_LIVE=on` | real Sandbox only if `TRADEPROOF_APPROVAL_PAYMENTS=sandbox` |

## Demo walkthrough

Sign in as `buyer-a` at <http://127.0.0.1:3000> and follow [`docs/demo-script.md`](docs/demo-script.md) (20 steps,
buyer and approver): create the SYNTHETIC request, paste the Chinese quote, run MOCK extraction and review every
value, compare, draft a bilingual clarification, record the supplier's reply, revise the request to a 20-piece
sample order, add the revised quote, assign the approver, approve as `approver`, and pay **USD 68.00** with the
simulated (MOCK) PayPal flow. The demo video shows this flow on a MOCK database.

## What is real and what is MOCK

| Evidence | What it shows | Where |
| --- | --- | --- |
| MOCK demo (video, demo script) | the full flow with MOCK extraction, MOCK Copilot and **simulated** PayPal | `docs/demo-script.md` |
| Real AI extraction (25 Oct 2026) | a real model extracted 5 SYNTHETIC quotes with sources; 3 complete, 2 with values that failed the evidence check (kept as incomplete) | `docs/live-model-acceptance.md` |
| Real Copilot runs (2 Nov 2026) | authorised real-model explanations on SYNTHETIC test records, validated against stored facts | `docs/copilot-cases.md` §5 |
| Real PayPal Sandbox payments | USD 1.00 (21 Oct) and USD 12.00 from a human approval (30 Oct; extraction in that record was MOCK), verified server-side | `docs/payment-validation.md` |

These were **separate tests**. TradeProof has **not** been verified as one real end-to-end AI → approval → PayPal
run, and the video does not claim it.

## AI in this project

| Where | What | Notes |
| --- | --- | --- |
| In the product | Anthropic Claude API (`claude-sonnet-5-5` in the recorded real runs) extracts values from pasted quotes and writes Copilot explanations | optional; needs your own key; never decides approval, amount or payment; the MOCK demo uses canned output instead |
| Planning and review | **ChatGPT** (OpenAI) helped me with project planning, requirement refinement, acceptance checklists, prompt drafting and reviewing the written materials | not used to run the local repository or its tests |
| Development | I built TradeProof with **Claude Code** (Anthropic's AI coding assistant), which did much of the local implementation, tests, documentation and the video production workflow under my direction | I set the requirements, made the product and safety decisions, authorised each step and did the manual acceptance |
| Demo video | Narration synthesised locally with Kokoro-82M (offline text-to-speech) | synthetic voice; no cloud TTS |

## Limitations (honest list)

- Quotes are **pasted text** only — no PDF, Excel, image or e-mail import.
- One full USD amount, paid once; **deposits and staged payments are blocked**. No exchange rates, no landed cost.
- The payee is **one fixed PayPal Sandbox test merchant** from the configuration — TradeProof cannot pay an
  arbitrary supplier's account. It is **not escrow** and never holds money. PayPal Sandbox only; no PayPal Live (production) mode.
- Nothing is sent to suppliers; there is no supplier portal. Copilot answers in English only.
- Local, single-machine use: preset accounts, no registration or e-mail password reset, no hosted deployment,
  `npm start` serves only the landing page.
- Tested on Windows 11 with Node 24.19.0 only.
- Known open test issues:
  - **exit 139 (crash)** in the multi-thread budget tests: in stress runs on 26 Oct, about 4 of 150 runs crashed when
    several thread tests ran in one test process; each thread test run alone passed 200 / 200. Cause unknown
    ([`docs/diagnostics/budget-threads-segfault.md`](docs/diagnostics/budget-threads-segfault.md)).
  - **`EPERM`** when `tests/approval.test.ts` removed its temporary folder: seen once (3 Nov) after all its tests had
    passed; re-running that file alone passed 33 / 33. A suspected cause (test databases left open) was fixed and
    later full runs were clean, which does not prove the issue is gone.
- Dependency advisory GHSA-mrwp-f3q8-3g9p in `follow-redirects` (transitive, via the PayPal SDK → `axios`) is fixed by
  pinning the patched 1.16.2 with an npm override; analysis in
  [`docs/security/follow-redirects-2026-11-09.md`](docs/security/follow-redirects-2026-11-09.md). `npm audit` still
  reports a moderate `minimatch` advisory in the development-only ESLint toolchain (not in the running app).
- The target customer is a hypothesis; no user research or market validation has been done.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test` (node:test; MOCK PayPal, fake/MOCK models, no network).
- Browser checks in `scripts/e2e/*.e2e.mjs` (Microsoft Edge via DevTools, on a database copy only).
- Results of the release-candidate check from a clean copy: [`docs/run-guide.md`](docs/run-guide.md) §11.

## Project layout

```text
src/app/              Next.js pages and API routes (procurement pages need sign-in)
src/lib/              shared model (procurement, quotes, extraction schema, comparator, approval entry)
src/server/           server-only modules: db, auth, access, procurement, quotes, extraction, comparison,
                      clarification, replies, approval, payments, copilot, budget, search
tests/                node --test suites
scripts/              local-mock.mjs (safe MOCK mode), account tools, seeds, e2e browser checks, release tools
samples/synthetic/    fictional quotes, requests and MOCK model outputs (SYNTHETIC / DEMO)
docs/                 product brief, designs, run guide, demo script, evidence, release plan, submission drafts
```

## Licence and credits

TradeProof's own code and documentation are released under the [MIT License](LICENSE), Copyright (c) 2026 Asher
Zhu. The MIT licence covers only the material in this repository that the author can license. Third-party
dependencies, AI models, services and tools keep their own licences and terms — see
[`docs/credits.md`](docs/credits.md).

TradeProof is an entry to the PayPal AI Hackathon (Sponsor: PayPal, Inc.; Administrator: Devpost). It has not been
certified or endorsed as a product by PayPal, Anthropic or OpenAI.
PayPal, Claude and ChatGPT are trademarks of their respective owners.
