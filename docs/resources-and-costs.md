# Hackathon Resources & Cost Tracker

> Checked 21 Oct 2026 from public Devpost pages. "Available on the page" ≠ "granted to my account". Nothing below has been claimed yet.
> Cash budget: **S$100 hard cap**, target S$0. Spent so far: **US$0.069710** Anthropic API usage (local estimate from reported usage, 25 Oct 2026); nothing else bought.

## Key rules (from Official Rules / Devpost)

- Submission window: 1 Oct 2026 – **12 Nov 2026, 12:00 pm PT** (13 Nov 04:00 SGT). Judging 1–15 Dec; winners ~21 Dec.
- Must meaningfully use PayPal (Sandbox) **and** AI; PayPal must be central.
- Submit: text description, working demo (repo run instructions or hosted URL), tools used, **public repo with open-source licence visible in About**, **YouTube video < 3 min**, English materials.
- Judging: stage 1 pass/fail; stage 2 equal weight (20% each) — Technological Implementation, Design, Potential Impact, Innovation, Presentation.
- Max two prizes per project: one Grand/Honourable + one Sponsor prize. Relevant special prizes: Best Use of PayPal + AI, Best Use of Agentic Commerce, Most Impactful, Best Demo Delivery.

## Sponsor resources

| Resource | What the page says | Claim / use path | Status | Cost risk | Evidence to keep for submission |
| --- | --- | --- | --- | --- | --- |
| **Render** | $50 Render credits for participants; Render sponsor prize = credits ($1k / $750 / $500) | Claim portal linked from <https://paypalaihackathon.devpost.com/details/render> (credits-portal on onrender.com) + render.com/docs/credits | **Not claimed. Not verified on account.** | Render may need a payment method on file; check before adding a card. Do not enable paid plans/auto top-up. | Render service URL, dashboard screenshot of credit balance (no billing details) |
| **APIMatic** | All who used the APIMatic Context Plugin may claim 1 month APIMatic Basic; winners of its prize get 6 months Business + $1k | Google Form linked from <https://paypalaihackathon.devpost.com/details/apimatic> | **Not claimed.** | Read form terms; free tier only | Commit showing context plugin installed (`npx context-plugins install …server-sdk-context-plugin-preview`), use of `@paypal/paypal-server-sdk` in code, short note in README "Tools used" |
| **AG Grid / AG Studio** | 45-day AG Studio trial licence; boilerplate `paypaldev/hackathon-paypal-ag-grid-boilerplate`; prize judges polish + Studio Agent Framework | <https://paypalaihackathon.devpost.com/details/aggrid> | **Optional, not installed.** | 45-day trial from activation must cover judging (1–15 Dec) → activating before ~1 Nov would expire before judging ends. Licence terms for public repo unverified. | — |
| Resources page | PayPal docs, AI-Toolkit, docs.paypal.ai (Agent Toolkit, MCP), sandbox guide repo, Discord, webinar recordings | <https://paypalaihackathon.devpost.com/resources> | Read | None | — |

## Runtime AI cost (product feature, separate from Claude Code)

TradeProof needs its own model API at runtime (quote extraction, bilingual drafts). Claude Max covers Claude Code (the coding assistant) but **not** API calls made by the app. Provider and budget to decide in phase 2; options include a pay-as-you-go API with a hard spending limit, or free credits if available. Not purchased.

Status 22 Oct 2026: runtime AI credit **to be verified** (not checked; nothing bought or claimed; no model API called by the app). Spend still **S$0**.

Status 24 Oct 2026: unchanged — still S$0, no model API called. Needed from the owner before the first real call (24 Oct extraction): provider and model, key storage (`.env.local`, Git-ignored), initial spend limit within the S$100 total cap. Translation checks (26 Oct) use the same provider; static UI translation never calls a model.

Status 24 Oct 2026 (evening): the extraction pipeline is built provider-neutral (`docs/quote-extraction.md`) and the app has **no live adapter**. `.env.local` has `AI_PROVIDER`, `AI_MODEL` and `AI_API_KEY` present but **empty** (values not printed). No model API was called, nothing was bought. Spend today **S$0**, cumulative **S$0**. Built-in guards for when a provider is approved: input ≤ 30,000 characters, output ≤ 4,000 tokens, 60 s timeout (not retried), at most 1 retry for transient errors, 3 live runs per quote version per 24 h, re-runs only with explicit consent. The suggested initial S$10 is **not** approved; the S$100 total cap stands.

Status 25 Oct 2026 (night): **provider decided by the owner** — Anthropic Claude API (direct), `claude-sonnet-5-5`, billing and ledger in USD. Prices verified from the official pricing page on 25 Oct: input US$2 / MTok, output US$10 / MTok (cache not used; `inference_geo: "us"` would be 1.1x). Authorised limits: US$1 and 20 calls per day, US$5 and 100 calls in total for this phase; no top-up, subscription, other paid model or higher limits; part of the S$100 cap. Enforced locally by the v9 ledger (only for calls through this app — an Anthropic Console spend limit is the account-wide control). First real-model acceptance: 5 calls, **US$0.069710** settled estimate, 0 unknown. The owner compared this with the Anthropic Console usage page and confirmed it (25 Oct); it remains a local estimate, not the official bill. Claude Code's subscription does not cover these API calls.

## Unverified / pending

- [ ] Render: does credit claim require a card? Does the credit expire before judging ends?
- [ ] APIMatic: exact form terms; whether using the preview plugin + server SDK is sufficient for "Best Use of APIMatic".
- [ ] AG Studio: trial start date vs judging window; licence compatibility with an open-source repo.
- [x] Runtime AI API: Anthropic `claude-sonnet-5-5` (25 Oct); about US$0.007–0.019 per extraction run on the synthetic cases (local estimate). Free credit availability not checked.
- [ ] Compare the local estimate with the Anthropic Console usage page (owner).
- [ ] Tunnel for webhooks (if not using Render): pick a free option.
