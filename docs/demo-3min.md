# TradeProof — 3-minute demo (English) · version 3 Nov 2026 (prepared ahead of the 4 Nov plan)

**Status:** script, shot list and preparation only. No video, slide or upload has been made or published. Nothing in
this plan makes a model, token-count or PayPal call. **4 Nov update:** narration shortened to 318 words; operation
times measured on a copy of the rehearsal database (see "Timing"). Word counts at a fixed speaking rate (2:27 at 130
words per minute) are **estimates of narration only, not the length of the finished video** — that is known only after
a timed run by the presenter. Aim for a finished video of about 2:40, safely under the 3:00 limit.

## What the viewer sees, by kind

| Kind | In this video | Say it as |
| --- | --- | --- |
| **MOCK** (canned / simulated) | the extraction result, the Copilot answer, the PayPal payment (MOCK gateway on the recording copy) | "MOCK", "simulated" — never "live AI" or "real payment" |
| **Deterministic, real code** | comparison, fee "unknown", clarification templates, reply/answer status, rule check, amount, approval binding, approver-only approval | as is |
| **Prepared before recording** (by the presenter, by hand) | value reviews, match, draft, reply + answers, request revision to the sample order, quote v2 review, requirement classification, approver assignment | "prepared before this recording, step by step" |
| **Real, verified separately** (not part of this run) | real model extraction of SYNTHETIC quotes (25 Oct); real Copilot answers on authorised cases (2 Nov); real PayPal Sandbox payments USD 1.00 (21 Oct, technical check) and USD 12.00 from a human approval (30 Oct; the extraction in that record was MOCK) | "verified separately" — shown only as an evidence card at the end |

**Must stay true in every frame and line:** quotes are **pasted text** (no PDF / Excel import); AI explains and drafts,
while approval state, amounts and payment are decided by deterministic code and the people involved; **not escrow**; it
cannot pay an arbitrary supplier — the payee is **one fixed Sandbox test merchant**; the separate real-AI and
real-Sandbox tests are **never presented as one real end-to-end run**; any fee arithmetic shown is a SYNTHETIC
illustration, not a measured saving.

## Shot list and narration

Two browser windows (buyer, approver), 1280 × 800 or larger, zoom 100–110 %, on the recording copy in MOCK mode.

| Time | Screen (who) | Action | Narration |
| --- | --- | --- | --- |
| 0:00–0:15 | Request page (buyer) | show title, items, Access panel | N1 |
| 0:15–0:40 | Compare page, quote v1 (buyer) | scroll the differences and the fee lines | N2 |
| 0:40–1:03 | Clarification draft (buyer) | EN / 中文 columns, then the saved reply and Q1 / Q2 status | N3 |
| 1:03–1:35 | Quotes page, version 2 (buyer) | decision summary at the top (Rule check "Needs confirmation · 1", Approval "Not approved", Payment "Not paid", "Proposed payment USD 68.00 — not payable until approved."); Copilot **How much is this payment…?** | N4 |
| 1:35–1:52 | Approval page (approver window; opened from the v2 summary **Review and approve**) | tick the confirmation → **Approve these conditions** | N5 |
| 1:52–2:03 | Quotes page, version 2 (**switch back to the `buyer-a` window**; reload) | summary "Approval ✓ Approved — Active", "Approved payment USD 68.00." → **Go to payment** | N6 |
| 2:03–2:25 | Approval page (`buyer-a`, from **Go to payment**) | **Start payment** → **Create MOCK order** → **Simulate buyer approval (MOCK)** → **Capture payment** → PAID (MOCK); before each next click, wait until the previous step's status is shown on the page (no blind clicks) | N7 |
| 2:25–2:42 | Evidence card (static, see below) | hold | N8 |

> **7 Nov — N2 corrected (owner's wording, 7 Nov):** the old N2 said "five differences". The comparison of the recording
> record's version 1 shows **six** (quantity, material, logo, currency, lead time, payment terms) — computed by the app's
> comparator on a byte copy of the closed recording file (setup-status "7 Nov 2026"). "Five" was inaccurate; N2 now
> describes the comparison without a number. The check result and the earlier versions stay in the history.

**Narration (read at an even pace):**

- **N1** — "Small businesses buying samples from overseas suppliers get quotes in Chinese, English, or both, and it is
  easy to pay for something that differs from what was asked. TradeProof keeps the request, every quote version and
  every decision on one record."
- **N2** — "The buyer pasted the supplier's quote as text. Extraction found each value with its source line; before
  this recording I checked every value against its line and confirmed it by hand. Here the extraction is MOCK: canned test output. The comparison uses deterministic rules
  to highlight differences between the request and the quote; fees the quote does not state stay unknown, never zero."
- **N3** — "Questions come from fixed bilingual templates; nothing is sent automatically. This is the clarification
  history for version one. Q1 was marked answered and Q2 partly answered. The basis has since changed, so these are
  historical readings, not approval of version two."
- **N4** — "The buyer revised the request to a twenty-piece sample order, then saved a revised supplier quote as
  version two. The current check still needs one confirmation. Sixty-eight US dollars is a proposed amount, not yet approved or payable. The
  Copilot explains TradeProof's own facts with sources; it cannot approve or pay, and here its answer is MOCK too."
- **N5** — "Only the approver the buyer assigned can approve, and a buyer cannot approve their own request. The approver
  confirms and approves these exact conditions."
- **N6** — "The approval is bound to this quote version and this extraction run. If the basis changes, it stops being
  valid."
- **N7** — "Now the buyer pays the sixty-eight-dollar sample order. This payment is MOCK: simulated on a test copy, no
  money, no PayPal request. The amount
  comes from the stored approval; the browser cannot change it. The payee is one fixed Sandbox test merchant, not the
  supplier. This is not escrow."
- **N8** — "The real parts were verified separately. A real model extracted synthetic test quotes and answered Copilot
  test cases, and a real PayPal Sandbox payment of twelve US dollars was made from a human approval. Those were separate
  tests, not one live end-to-end run."

**Evidence card (static frame for N8; text only, prepared by the presenter, no account data):**

> Verified separately — not part of this recording
> • Real model extraction of SYNTHETIC quotes — 25 Oct 2026 (5 runs; 2 were marked INCOMPLETE by the evidence check)
> • Real Copilot answers on authorised test cases — 2 Nov 2026 (validator ≠ semantic proof)
> • PayPal **Sandbox**: USD 1.00 technical check (21 Oct) · USD 12.00 from a human approval (30 Oct; that record's
>   extraction was MOCK) — server-verified and checked against PayPal's Sandbox records
> This video: MOCK extraction · MOCK Copilot · MOCK PayPal

Sources for the card: `docs/live-model-acceptance.md`, `docs/copilot-cases.md` §5, `docs/payment-validation.md`,
`docs/setup-status.md` (30 Oct night). The real records cannot be opened in the signed-in UI (they predate account
ownership), which is why they appear as a card, not as live screens. Any screenshot from the PayPal Sandbox dashboard
is the owner's choice and must hide e-mail addresses, account and merchant IDs, order and capture IDs.

## Timing

Word count of N1–N8 (counted by a script on this file, 4 Nov 2026; v3 had 335 words):

| N1 | N2 | N3 | N4 | N5 | N6 | N7 | N8 | Total | 120 wpm | 130 wpm | 140 wpm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | 48 | 41 | 56 | 24 | 20 | 45 | 43 | **318** | 2:39 | 2:27 | 2:16 |
| 41 | 57 | 41 | 56 | 24 | 20 | 49 | 43 | **331** (6 Nov: N2 states the presenter's own review before recording; N7 names the USD 68 sample order as MOCK) | 2:46 | 2:33 | 2:22 |
| 41 | 57 | 41 | 58 | 24 | 20 | 49 | 43 | **333** (7 Nov, before the first timed rehearsal: N3 = clarification history of version 1, historical readings, not approval of version 2; N4 opening = revised supplier quote saved as version 2, current check still needs one confirmation) | 2:46 | 2:34 | 2:23 |
| 41 | 63 | 41 | 58 | 24 | 20 | 49 | 43 | **339** (7 Nov, owner's N2 wording: comparison described without a number; "five" was inaccurate, six measured) | 2:50 | 2:36 | 2:25 |

The wpm columns are narration-only estimates, **not** a measured video length. Timed rehearsal: **尚未实测 / not
measured yet**.

**Operation times (4 Nov, automated, not a person).** Measured on a *copy* of the rehearsal database
(`mock:start`, MOCK; Edge headless at 1280 × 800; each page opened once before as warm-up, as a presenter would). Time
from click / navigation until the result is on screen:

| Shot | Operation | Time |
| --- | --- | --- |
| S1 | request page | 0.3 s |
| S2 | compare page, version 1 | 0.5 s |
| S3 | clarification draft | 0.4 s |
| S4 | quotes page, version 2, until the Copilot panel is ready | 1.9 s |
| S4 | Copilot "How much is this payment…?" → answer | 1.5 s |
| S5 | approval page (approver) | 0.3 s |
| S5 | tick the one confirmation, **Approve these conditions** → "Approved — Active" | 1.5 s |
| S6 | quotes page, version 2 (buyer) shows "Approved — Active" | 0.7 s |
| S7 | approval page (buyer), payment panel | 0.5 s |
| S7 | Start payment → Create order → Simulate buyer approval → Capture → PAID (MOCK) | 1.4 + 1.3 + 1.4 + 1.7 s |

Result in that run: one confirmation item; PAID (MOCK) USD 68.00, payee "Fixed Sandbox test merchant … not the
supplier". The machine's waiting time is about 15 s over the whole video, and almost all of it can run while the
presenter speaks. Mouse movement, scrolling, window switches and pauses were **not** measured (that needs a person).

What this means for the cut:

- **S4 and S7 are the tight shots.** S7 has four clicks in 22 s with N7 (45 words ≈ 21 s at 130 wpm). Start the
  first click while saying "Now the buyer pays". Keep speaking while the page works, but click the next payment step
  only after the previous step's status is shown on the page — never click ahead of the actual state (7 Nov rule).
- **Switch windows twice only** (buyer → approver at S5, approver → buyer at S6). Keep both windows signed in and
  the pages opened once before recording, so no page compiles during the take.
- **S2: scroll, don't read.** The compare page header is long at 1280 × 800; the differences are below the fold.
  Scroll straight to the differences table while N2 is spoken.
- If the timed run is over 2:45, cut words from N1 and N8 first, never the MOCK / not-escrow / separate-tests
  statements.

Display fix found by this run: on the approval page the payment facts squeezed into a narrow column once a payment
record existed (all values wrapped word by word at 1280 px) — fixed on 4 Nov (`9b7f25c`, display only).

## Timed rehearsal procedure (7 Nov 2026, copy `data/mock/rehearsal-2026-11-07.sqlite` only)

Status: **procedure only — 尚未实测 / not measured yet.** A rehearsal counts as timed only when the full narration was
spoken from the first word of N1 to the end of the evidence card; a word count never substitutes for it.

**Before the clock (not timed; no approval, no payment):**

1. One server only, started by the owner: `$env:TRADEPROOF_MOCK_DB = "data\mock\rehearsal-2026-11-07.sqlite"`,
   `npm.cmd run mock:check` (must show that file · READY MOCK · Copilot off · payments MOCK), `npm.cmd run mock:start`.
2. Two windows that do **not** share cookies (e.g. a normal Edge window = `buyer-a`, an InPrivate window = `approver`);
   the owner signs in to both.
3. `buyer-a` window: open once, as tabs in order, request page, compare v1, clarification draft, Quotes v2, evidence card
   (`data/demo/evidence-card.html`, local static file).
4. **Owner checks the draft page (L3) before the clock:** Q2 shows **Open — partly answered** (stored: `PARTLY_ANSWERED`
   on the second, SYNTHETIC reply) and whether a "basis changed" box appears at the top (request now revision 2, quote
   version 2 exists). If either differs, stop and report — nothing is changed in the data.
5. `approver` window: Quotes v2 open; expect "Review and approve: tick 1 confirmation, then "Approve these conditions"."
6. Back to the `buyer-a` window, request-page tab.

**On the clock (first word of N1 → end of N8 on the evidence card):**

| Shot | Narration | Who | Page | Action | Expected on screen |
| --- | --- | --- | --- | --- | --- |
| 1 | N1 | `buyer-a` | request | show title, items, Access | PR-64475DFD, revision 2, approver assigned |
| 2 | N2 | `buyer-a` | compare v1 | scroll to the differences and fee lines | differences; unstated fees "unknown" |
| 3 | N3 | `buyer-a` | clarification draft | EN / 中文 columns → **Supplier replies**, second reply → **Answers per question** | Q1 "Answered — your reading"; Q2 "Open — partly answered" |
| 4 | N4 | `buyer-a` | Quotes v2 | decision summary → Copilot **How much is this payment, and which costs are unknown or excluded?** | "Decision for version 2 of 2"; Rule check "Needs confirmation · 1"; Approval "Not approved"; Payment "Not paid"; "Proposed payment USD 68.00 — not payable until approved."; MOCK answer |
| 5 | N5 | **switch to `approver` window** | Quotes v2 → approval page | **Review and approve** → tick the 1 confirmation → **Approve these conditions** | "Approved — Active" |
| 6 | N6 | **switch back to the `buyer-a` window** | Quotes v2 | reload → **Go to payment** | Approval "Approved — Active"; "Approved payment USD 68.00." |
| 7 | N7 | `buyer-a` | approval page, payment panel | see the step list below — wait for each actual status, no blind clicks | "PAID (MOCK) — captured on the simulated MOCK PayPal …"; payee "Fixed Sandbox test merchant … not the supplier" |
| 8 | N8 | — | evidence card tab | hold until N8 ends; stop the clock | evidence card |

Shot 7 payment steps — click the next button only after the page shows the previous result (button no longer reads
"Working…", and the result line / status pill has updated):

1. **Start payment (create the payment record)** → wait for status `NEW` "Payment record created — no MOCK order yet (simulated; no PayPal request)."
2. **Create MOCK order** → wait for status `ORDER_CREATED` "MOCK order created — waiting for the simulated buyer approval (no PayPal request)."
   (Labels since fix 9 Nov / commit after `34a8634`; a MOCK record's labels follow its own sku.)
3. **Simulate buyer approval (MOCK)** → wait for its result line (status pill stays `ORDER_CREATED`; **Capture payment**
   is already visible at this point — do not click it before the result line appears).
4. **Capture payment** → wait for status `PAID` with the MOCK_PAID text above.

If any step shows an error or an unknown outcome, stop the clock, do not click again, and report the exact message.

**Record after the run:** real total (target about 2:45), the two slowest shots, words to cut (N1 / N8 first; never
the MOCK / not-escrow / separate-tests statements). (N3 / N4 wording aligned with the current pages on 7 Nov before
the first timed run; see "Timing".)

## Recording copy and who prepares what

**Recording copy:** `data/mock/recording-2026-11-03.sqlite` (Git-ignored, never the main database). Prepared by the
operator script `mock:seed-base` on 3 Nov: accounts `buyer-a`, `buyer-b`, `approver` (with random passwords nobody
knows — the presenter sets their own, item 1 below), and **base material only**: the SYNTHETIC request (revision 1,
owned by `buyer-a`), quote version 1 (the built-in Chinese demo quote) and one MOCK extraction run. **No value review,
match, draft, reply, answer, revision, classification or approver exists in it.**

**Rehearsal copy (not for recording):** `data/mock/rehearsal-2026-11-03.sqlite`, prepared by `mock:seed` — every review,
answer and classification there was **written by the script**, not by a person. Used only to check screens, facts and
page timings (approval preview READY WITH CONFIRMATIONS, 6800 cents = USD 68.00, for both buyer and assigned approver).

### Presenter's checklist (owner, when free — short version, 4 Nov)

**State of the recording copy (checked read-only on 4 Nov; re-checked on a byte copy on 6 Nov — same SHA-256 `c0240ae8…`, same rows):** unchanged since it was created on 3 Nov 18:17 SGT —
3 accounts, 0 sessions, request PR-64475DFD revision 1, quote version 1, one MOCK run, **0 value reviews**, no draft,
reply, classification, approver or approval, ledger 0, payment records 0. Nothing a person did is in it yet, so nothing
had to be preserved. Do **not** use `data\mock\rehearsal-2026-11-03.sqlite` for the recording: everything in it was
written by a script.

**A. Start (PowerShell, in the TradeProof folder; your passwords are typed only by you, hidden):**

```powershell
$env:TRADEPROOF_MOCK_DB = "data\mock\recording-2026-11-03.sqlite"
npm.cmd run mock:check            # must show: database …\data\mock\recording-2026-11-03.sqlite · READY MOCK · Copilot off · payments MOCK
npm.cmd run mock:reset-password   # type: buyer-a   then your new password twice (≥ 12 characters, not shown)
npm.cmd run mock:reset-password   # type: approver  then your new password twice
npm.cmd run mock:start            # leave this terminal open
```

If `mock:check` shows any other database or mode, stop and do not continue.

**B. Open, signed in as `buyer-a`** (<http://127.0.0.1:3000/login>):

- Request: <http://127.0.0.1:3000/procurements/pr_64475dfd-e178-4342-b79d-7686e7ddd2ac> — expect PR-64475DFD,
  revision 1, Access: no approver.
- Quotes, version 1:
  <http://127.0.0.1:3000/procurements/pr_64475dfd-e178-4342-b79d-7686e7ddd2ac/quotes?series=qs_9a7894b3-2413-47a1-b3f0-17339c377176&version=qv_f1b9caed-6d04-4b31-a623-d1d4e12c516a>
  — expect "Decision for version 1 of 1", one MOCK run, "Reviewed 0 of 25".

**C. Do by hand, in this order** (`docs/demo-script.md` steps 4–16; the MOCK run exists already):

1. v1: **Confirm** each value only after reading its source line under it, and **Save match** for the one item (25 targets =
   24 values + 1 match; **Next to review** jumps to the next open one; a reviewed value is changed only via **Review again**). Source =
   the pasted Chinese demo quote shown on the page; the values must match that line, not your expectation.
2. Compare → create the clarification draft; paste the reply (demo-script step 7); record Q1 "answers it" and Q2
   "answers it partly" with the excerpts from step 8.
3. Request → Edit to the sample order exactly as step 11; add quote v2 (step 12).
4. v2: **Save match** and **Confirm** each value against its source line (the bar shows the exact count). Values to see, from the revised quote
   text: 20 pcs · 304 · 500 毫升，哑光黑 · 激光雕刻 1 色 · USD 3.40 → USD 68.00 · 100 % before shipment.
5. Approval preview (v2 decision summary → **Full approval preview**): both requirement classifications with the reasons in step 14; then Request → Access → assign
   `approver` (step 16).
6. Check (read only): approval preview **READY WITH CONFIRMATIONS**, one confirmation, **USD 68.00**. Do not approve —
   steps 17–19 (approve, MOCK payment) are recorded live.

**D. Stop:** in the server terminal press **Ctrl+C** (answer `Y` if asked), then `npm.cmd run mock:close`, then
`Remove-Item Env:TRADEPROOF_MOCK_DB`.

**When it may be called "reviewed by a person":** only after you have done C1–C5 yourself in this copy and tell me so.
I will then check the stored rows (reviews by `buyer-a`, answers, classifications, grant) and record them as
*performed by the owner*; the database alone cannot prove that each source line was read, so your statement is the
evidence. Until then the record stays "base material, not reviewed". A script will never fill this copy.

Then, when convenient: one timed rehearsal on the prepared copy (adjust narration, not facts, if over 2:45), the
evidence card frame (text above), and the recording itself.

Before recording: browser notifications off; no other tabs, bookmarks bar or personal data visible; the address bar
shows only `127.0.0.1:3000`; the MOCK labels visible on screen; no `.env.local`, terminal with keys or PayPal dashboard
visible.

## Wording rules

- Say **MOCK** for extraction, Copilot answers and payment in this recording.
- The Copilot English v1 was accepted by the owner with disclosed limits (3 Nov); in this video its answers are MOCK.
- Never "AI approves", "AI pays", "saves you X %", "escrow", "pay any supplier", "imports PDF / Excel".
- The SYNTHETIC fee example in `docs/product-brief.md` (USD 800.00 → USD 980.00, +USD 180.00 = 22.5 %) is a fictional
  illustration of a missed fee line, not a measured saving; if used anywhere, label it so.
