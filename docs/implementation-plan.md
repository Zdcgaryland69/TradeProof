# TradeProof — Implementation Plan

> Deadline (Official Rules): submissions close **Thu 12 Nov 2026, 12:00 pm PT** (= Fri 13 Nov 2026, 04:00 SGT). Planned submission **11 Nov**, buffer **12 Nov**.
> Schedule re-planned on **23 Oct 2026** and updated on **24 Oct 2026** with the owner-approved additions (buyer type, references, search, languages, translation check, access control). Dates are SGT targets. The owner reviews each step before the next starts.
> Product scope: `docs/product-brief.md`. Design of the 24 Oct additions and their migration plan: **`docs/design-24oct-additions.md`**. What is verified: `docs/setup-status.md`.
> Extra cash budget: **S$100 total, hard cap**; target as close to S$0 as possible. Spent so far: **US$0.138702** in Anthropic API usage (local usage-based ledger estimates, not invoices: US$0.069710 extraction 25 Oct + US$0.034648 Copilot run L1–L6 + US$0.023922 re-run L3–L5 + US$0.010422 L3 check, 2 Nov); nothing else.

## Schedule update (owner, 7 Nov 2026, SGT) — current

Owner's order for the final stage (7 Nov). Each step starts only when the previous one has a verified result; dates
are SGT **targets, not assumed outcomes**. If a critical defect is found, decorative design is cut — verification time
is not.

1. Full business-chain check against the committed scope and fixes of correctness defects.
2. UI/UX design and implementation (representative pages first: Quotes page + approval page / requirement
   reclassification; the remaining pages only after the owner confirms the direction).
3. Regression after the design changes and targeted owner acceptance.
4. Freeze, then the video on the frozen version.
5. Final release-candidate verification, release preparation, submission.

| Date (SGT) | Target | Done when |
| --- | --- | --- |
| 7 Nov | Full-chain check; fix critical defects; when clean, start UI/UX (representative pages) | requirement–evidence–gap table written; critical defects fixed and re-verified **done 7 Nov:** table in setup-status "7 Nov 2026"; defect fixed `a7bfd6b`; representative UI `50f0860` built, **owner design check open** |
| 8 Nov | Design implementation, owner acceptance, related regressions; freeze when the conditions hold | owner confirms the design and the targeted checks — **7 Nov night:** main-flow design built + automated checks pass (`ac92091`); **7 Nov evening (SGT, ahead of this row):** unconfirmed-write fix (`efcea94`, `bf9be39`, 19:22); **owner acceptance PASSED** 21:24–21:40 (five steps on `ui-review-2026-11-07`); **UI/UX frozen at code commit `097a11a`**. No model / token-count / PayPal calls; video not started |
| 9 Nov | Recording on the frozen version, video first cut, final candidate verification | new MOCK copy, measured rehearsal, recording (Continue entry: setup-status "7 Nov 2026 (late evening, SGT) — owner acceptance PASSED") — **done early, 8 Nov afternoon (SGT):** video copy `data/mock/video-2026-11-08.sqlite`, recorded (owner signed in, scripted clicks, MOCK approval + MOCK payment PAID USD 68.00), rough cut v0 **2:40.9** without final voice; **open:** voice choice, owner review of v0, final cut. Details: setup-status "8 Nov 2026 — video". **8 Nov evening:** owner ordered the two payment-display defects fixed in the app → fix `34a8634` (MOCK step result says MOCK; Money panel splits payment made vs. what can be done now; dev badge off), verified on `data/mock/fixcheck-2026-11-08.sqlite` with screenshots; **open:** owner acceptance of `34a8634` (then it is the recording code), re-record take t2 on a new copy, Kokoro download go / no-go, final cut + measured length. Details: setup-status "8 Nov 2026 (evening, SGT) — payment-display fix". **9 Nov evening: video FINAL, owner accepted** (2:36.7, v2b/t4/af_heart, MOCK payment; hashes in setup-status "9 Nov 2026 (evening, SGT) — video FINAL accepted") |
| 10 Nov | Final release candidate, clean-environment verification, README and submission material | owner decisions (licence, public-repo method, hosted demo, live rules check, video upload) given → candidate rebuilt on final commit and verified from a clean clone; submission text drafted for owner review — **done early, 9 Nov night (SGT):** decisions given (MIT / Asher Zhu, fresh one-commit public repo, no hosting, YouTube material only); candidate `rc-2026-11-09-aeb9898` verified (npm ci, lint, typecheck, build, 517/517, MOCK browser smoke 29/29, npm start 404-by-design); README, credits, Devpost + YouTube drafts written. **Later 9 Nov:** follow-redirects advisory fixed (override 1.16.2, `91834f6`), materials aligned (`1c75e7b`), candidate `rc-2026-11-09-1c75e7b` verified (517/517, smoke 29/29, MOCK payment regression 11/11 + 5/5 after restart, prod audit 0); review pack written. **Open (owner):** public author e-mail, review of the pack, remote repo / upload / submission authorisation |
| **11 Nov** | **Internal submission target** (official deadline 13 Nov 04:00 SGT unchanged) | submitted |

The timed English rehearsal of 7 Nov afternoon was prepared (rehearsal copy, owner-confirmed 333-word narration in
`docs/demo-3min.md`) but **not measured**: the rehearsal copy shows only two sign-ins at 15:53–15:54 SGT, no approval
and no payment. It moves behind the design work (step 4). No video has been made.

## Schedule update (owner, 5 Nov 2026, SGT) — superseded on 7 Nov, kept as history

| Date (SGT) | What | Done when |
| --- | --- | --- |
| 5–6 Nov | Targeted UX improvements (5 Nov: decision summary on the Quotes page, review progress — see setup-status "5 Nov 2026 — decision summary …"; paid-state wording, regressions — "5 Nov 2026 (later)") | **owner PASSED A / B / C (AC23–25), 5 Nov**; AC26 automated regression passed; owner visual check of the screenshot passed (MOCK, no new payment) |
| 7 Nov | Owner's manual acceptance; fix the defects it finds | owner states the result |
| **8 Nov** | **Feature freeze** (was 6 Nov) | nothing new after this |
| 8–10 Nov | Release preparation (final candidate via `scripts/release-candidate.mjs`, three owner decisions) and recording | — |
| **11 Nov** | **Internal submission target** (official deadline 13 Nov 04:00 SGT unchanged; rules: https://paypalaihackathon.devpost.com/rules) | submitted |

The earlier schedules below are kept as history. Resources: US$100 API credits **reported by the owner** (provider, scope and expiry not verified); this round used 0 model, token-count and PayPal calls.

## Where the project stands (2 Nov 2026, SGT — Copilot v1 built and MOCK-verified; schema v18 applied; real AI acceptance open)

- **Owner decision (2 Nov):** start the Copilot early and do more per day so features freeze earlier and leave time for checks, review and fixes. More work per day ≠ heavy jobs in parallel, ≠ more scope. Copilot v1: English answers only (existing EN / 中文 clarification unchanged); five buttons, no free text; AI only explains deterministic facts with sources; no writes / confirmations / approvals / payments / messages by AI; no import, supplier portal, auto-translation, risk score or other deferred feature. Limits: content package ≤ 12,000 characters, max_tokens 1,000, 60 s, no SDK or application retry, no automatic re-send after invalid / truncated output or an unknown result; shared budget (US$1 / 20 calls a day, US$5 / 100 total). Real run: six asks, total reservation cap US$0.20, only after authorising the concrete list.
- **Resume check:** baseline equal to the 1 Nov handover (HEAD `e557495`, v17, integrity ok, FK 0, payments 2 PAID, events 17, approval ↔ payment 1, approvals 11, ledger 5 / US$0.069710, old records unowned, server stopped, port free).
- **Built 2 Nov (`10dd015`, `ce7ffe4`, `6b551eb`):** read-only `ApprovalService.readFacts`; Copilot server (facts, links, NEXT_STEP, basis, prompt, validator, MOCK, ask flow with re-authorisation and OUTDATED, idempotency, routes); shared ledgered call; **schema v18** (ledger purpose COPILOT_ANSWER — rehearsed, restore-drilled, applied to the main DB, existing data identical); panel on the Quotes page; offline cost bounds; guarded real-run script (not run live).
- **Evidence:** automated 463/463 (46 new); build pass; browser **MOCK** 23/23 on a copy (first run found a double-click → two POSTs defect, fixed). **No real AI evidence** (model / token count / PayPal calls 0). **No owner acceptance yet.** Status: **"built, MOCK-verified; real acceptance open"**.
- Details: `docs/setup-status.md` "2 Nov 2026 — Copilot v1 built …".
- **2 Nov (later):** evidence round — server idempotency restart-safe and payload-bound (ledger gate), evidence output for an authorised run, restore procedure corrected and drilled on temp copies, real-run list revised (L1–L6 cover all five buttons; bound US$0.1208, cap US$0.20; to run on the main DB — owner decision), MOCK acceptance environment running on a copy for the owner. Still: real AI not run; owner acceptance not done. Details: `docs/setup-status.md` "2 Nov 2026 (later)".
- **2 Nov (evening):** **owner MOCK acceptance of the Copilot passed (five steps)** — MOCK only, not real-AI verification. Owner decision: **no cumulative cap on approver assignment**; checked that a repeated assignment adds no record and that re-assignment never restores an approval made before a removal (code, new access test, the owner's own data). Real AI still not run / not authorised. Details: `docs/setup-status.md` "2 Nov 2026 (evening)".

- **2 Nov (night):** owner-authorised **real Copilot run L1–L6** on the main DB: 6 requests + 6 token counts, reserved US$0.089739 (cap 0.20), settled US$0.034648; validator passed L1/L2/L3/L6, rejected L4/L5 (supplier-text numbers / wording; not re-run). **Owner review of the six answers open**; open question whether attributed supplier quotes may pass the validator. Details: `docs/setup-status.md` "2 Nov 2026 (night)".

- **2 Nov (late night):** fixes after the real run (payment answer completeness, trusted-facts-first prompt, narrowed wording, fact keys); offline replay of the six saved outputs: L3 rejected now (omission), L4 / L5 still rejected, L1 / L2 / L6 pass; complete answers for L3–L5 pass. Copilot **not** recorded as real-AI accepted. Proposed minimal re-validation L3–L5 (bound US$0.069332, cap US$0.08) — not authorised. Details: `docs/setup-status.md` "2 Nov 2026 (late night)".

- **2 Nov (late night, re-validation):** authorised real re-run L3–L5: reserved US$0.048153, settled US$0.023922; all three explanations rejected by the validator — assessed as validator / tagging false positives (content complete); not re-run; no rule changed. Copilot **not** real-AI accepted; owner review + decisions open. Spend so far US$0.128280.

- **2 Nov (late night, validator .5):** three validator false positives fixed narrowly; fee category / payment scope separated; prompt .3 (not yet seen by the model); offline replay: re-run L3–L5 pass, first-run verdicts unchanged; notice automated browser check 25/25 (owner visual check open). Copilot acceptance pending.

- **2 Nov (late night, L3 check):** authorised single real L3 run (facts .6 / prompt .3 / validator .5): validator passed; settled US$0.010422 (local estimate). Owner review + notice visual check open.

- **2 Nov (end of day):** owner passed the L3 check answer and the fixed-notice visual check. Per-case evidence in `docs/copilot-cases.md` §5: only L3 called live under the final rules (facts .6 / prompt .3 / validator .5); L4 / L5 not re-called under prompt .3 (offline replay only); L1 / L2 / L6 only in run 1. Overall Copilot acceptance: owner decision, not recorded as passed. Limit: L3 S10 holds only for the fees listed in the record. Server stopped; DB closed; ledger 15 / US$0.138702.

- **3 Nov:** the three pending browser regressions pass on copies (clarification 22/22 + 6/6; access 21/21 after script fixes; approval-payment MOCK 11/11 + 5/5; first failures kept and classified in setup-status). Whole demo flow rehearsed on ONE SYNTHETIC record in **MOCK only** (`docs/demo-script.md`, AC21) — a demo-data addition (revised sample-order quote + MOCK output) was needed to reach a MOCK payment; wording fixes. Approver assignment limit built (AC20; no migration). 487/487 then a final 487/488 (one teardown EPERM on a temp folder, file re-ran 33/33 — environment, unproven), lint, typecheck, build pass; main DB identical; calls 0. Details: `docs/setup-status.md` "3 Nov 2026 — end-of-day handover".

- **3 Nov (close):** owner accepted the Copilot English v1 with the disclosed limits; walkthrough steps 1–3 passed (MOCK, copy); optional step 4 MOCK payment not performed there — automated browser evidence only. Status: Copilot = **accepted (owner), real-call evidence by version as recorded**; no new feature started. Freeze 6 Nov, checks 7–10 Nov, internal submission 11 Nov unchanged.
- **3 Nov (later):** owner decisions applied — demo data kept + checked; Copilot facts .7; entry state; 3-minute script `docs/demo-3min.md`; review pack. 492/492, build pass; calls 0. Details: `docs/setup-status.md` "3 Nov 2026 (later)".

- **4 Nov:** local release candidate tool + candidate (tracked files only, manifest + scan, nothing published); full clean-copy verification on `rc-2026-11-04-658753d` (build pass, `npm start` landing-only by design, MOCK browser smoke 17/17, MOCK payment); display fix `9b7f25c`; current candidate `rc-2026-11-04-28ca791` differs in five files (four docs + the separately checked fixed page): **not re-verified as a whole**. Demo v4; recording DB **not reviewed by a person**; live rules pages 403 (local copy quoted, owner to check). Commits `d2092c1`, `658753d`, `9b7f25c`, `28ca791`, `40f31ce`, `1f4c7fb`. Calls 0. Details: `docs/setup-status.md` "4 Nov 2026".
- **5 Nov (early morning):** night stop, hand-over only. Main DB not re-checked; last check 4 Nov (v18, ledger 15 SETTLED / US$0.138702 local estimate, 2 PAID, 17 events, 1 link, hash `9efe3316…`). Open: person typing hidden passwords, manual Ctrl+C, EPERM (suspected cause fixed, not proven gone), segfault (unresolved). **Three release decisions pending the owner** (licence + attribution, public-repository method, deploy or not) — proposals are not authorisation.
- **6–7 Nov:** recording copy `data/mock/recording-2026-11-03.sqlite` prepared **by the owner by hand** (v1 + v2 reviews, reply + Q1/Q2, request revision 2, v2, classifications, approver) and closed with `mock:check` + `mock:close` (quick_check ok; SHA-256 `092305b4…`). **Start point:** v2 · READY WITH CONFIRMATIONS · 1 specification confirmation · USD 68.00 · no approval, no payment. Additional requirements: the user confirmed a mis-selection (`NOT_KEY`); Claude, authorised, appended the correction `KEY_IN_QUOTE` (excerpt `20 个（样品单）`) through the formal endpoint (one POST, 201) from a page the owner signed in to; old row kept. Rehearsal copy `data/mock/rehearsal-2026-11-07.sqlite` (same hash) — **prepared, not yet fully narrated or timed**. Demo docs aligned with the 5 Nov UI (`40da016`). Calls 0. Details and next Continue: `docs/setup-status.md` "6–7 Nov 2026".

**Pre-freeze to-dos (before 6 Nov freeze; owner-listed / found 3 Nov):**
- ~~Browser visual check of the Copilot fixed notice "answered ≠ approved"~~ — **passed by the owner, 2 Nov**.
- ~~Short-time limit on approver **assignment** changes~~ — **built 3 Nov** (10 new GRANTs / buyer / request / rolling 10 min; removal never limited; automated only; AC20).
- ~~Found 3 Nov: four Copilot wording items~~ — **done 3 Nov (later), facts .7** (MOCK vs Sandbox by environment; approver / buyer next step by state at a non-blocked check; readable field names; exact repeats merged, the two budget reasons kept with their basis). Offline replay: real-case facts identical, verdicts unchanged.
- ~~Found 3 Nov: Quotes-page entry does not show an Active approval~~ — **done 3 Nov (later)** (selected version only; another version's Active approval named apart; read-only status). Demo addition **kept** (owner, 3 Nov); data checked and two gaps fixed.
- ~~Owner's reading of the review pack and the overall Copilot decision~~ — **3 Nov close: owner accepted the Copilot English v1 with the disclosed limits** (L1 / L2 / L4 / L5 / L6 answers passed in the review pack, L3 earlier; real calls at their recorded versions, offline replay and owner confirmation kept apart; not all cases re-called under the final version).
- **Open:** EPERM in a test teardown — likely cause fixed, proven by one clean run only; thread-test segfault unresolved.
- **Deferred (found 3 Nov, kept):** re-confirming an already confirmed value appends a review row (after approval: invalidates it, fail-safe); no direct approval-page link on the request page for the approver.

### Schedule from 2 Nov (owner-approved re-plan; dates SGT targets; replaces the 3 Nov onward rows of "Remaining schedule (re-checked 1 Nov)", kept below as history)

| Date | Step | Real state (2 Nov, end of work) | Done when |
| --- | --- | --- | --- |
| **2 Nov** | Resume check; plan update; Copilot server minimum (access, read-only facts, evidence, citations, MOCK, core tests); if possible migration + real-adapter preparation | **done:** server + tests; v18 rehearsed + applied; panel and MOCK browser check also done (brought forward from 3 Nov); real-run list + cost bounds prepared | — |
| **3 Nov** | (2 Nov end-of-day state: Copilot built, real calls done as summarised in `docs/copilot-cases.md` §5, overall acceptance pending owner decision.) Remaining 3 Nov items: owner check of the panel (MOCK) if the owner wants it now; late-response browser check (version switch while asking); re-run `clarification.e2e`, `access.e2e`, `approval-payment.e2e` (one at a time); **authorisation request for real calls** delivered | **3 Nov done:** the three regressions pass; MOCK demo-flow rehearsal + script; assignment limit built; wording fixes. Not done: late-response browser check (not repeated); no new real-call request (none needed today) | regressions pass; demo script exists |
| **4 Nov** | Owner acceptance (no code changes, builds or stress tests while the owner checks); **if authorised:** real run L1–L6 (≤ US$0.20), each answer and its sources checked by a person; fixes. MOCK results are never recorded as real AI verification | superseded: Copilot accepted 3 Nov; 4 Nov used for the local release candidate + clean-copy verification (see 4 Nov bullet) | owner acceptance recorded; real-run evidence only if authorised and run. If the real run slips to 5 Nov morning, the reason is recorded and deployment work that day moves accordingly |
| **5 Nov** | Core-path regression; access and sensitive-data check; demo rehearsal; deployment plan + reproducible run material. Public deployment, public repository and webhook only within an explicit authorisation — otherwise prepared, not published | deployment **not started**, **not decided** (owner decision pending); public repository not created; webhook **never verified**; 5 Nov early morning: hand-over only | regression recorded; deployment prepared or done within authorisation |
| **6 Nov** | Fix acceptance findings; key screens and demo readability; **feature freeze by end of day**; export reconsidered only if nothing core is blocked and there is clear slack | export not started (at risk) | freeze recorded |
| **7–10 Nov** | Staged final checks, review, defect fixes, README / run instructions, English demo material and video; after the freeze only defect fixes and necessary wording, regression by impact (not the whole suite every day); at least one buffer day; 10 Nov full pre-submission check | — | 10 Nov check passed |
| **11 Nov** | **Internal submission target** (not an officially verified deadline; official deadline per Official Rules: 13 Nov 04:00 SGT) | — | submitted |

**3 Nov (prepared ahead, owner-authorised):** the 4–5 Nov preparation items "reproducible run material", "demo rehearsal" and "deployment plan" were done on 3 Nov: `docs/run-guide.md` (verified from a clean clone), `docs/demo-3min.md` v3, `docs/release-plan.md` (recommendation: local reproducible run; hosted demo only on an explicit owner decision before the 6 Nov freeze). 4 Nov has no required owner task. Freeze 6 Nov, checks 7–10 Nov, internal submission 11 Nov unchanged.

**Deferred items kept with their real state (unchanged):** reference exchange rates + cost overview — deferred; tax / duty engine — not planned; A–D readiness grade — deferred; full trade-sheet fee preview — deferred; proof checklist, issue-handling summary — deferred; mailbox / quote-file import — evaluation only; evidence export — at risk; webhook — not done; deployment — not started; 简体中文 Copilot answers — not in v1 (owner, 2 Nov).

## Where the project stood (1 Nov 2026, SGT — resume check; owner UI confirmations A + B passed; Copilot plan revised)

- **Baseline (read-only, 1 Nov ~13:55 SGT):** main, HEAD `b42f693` at start, tree clean; schema v17, integrity ok, FK 0; Sandbox payments 2 PAID (USD 1.00, USD 12.00), payment events 17, approval ↔ payment 1; AI ledger 5 SETTLED, US$0.069710; approvals **11** (9 earlier + 2 on R1); LIVE runs 5. Matches the 31 Oct handover; nothing changed to match a number.
- **Owner UI confirmations (only viewing existing data, nothing saved):** A = Buyer A's approval entry on R1 Quotes page; B = R2 reply form (Q2 pointer, labels, data unchanged). **Both passed — owner-confirmed 1 Nov** (AC16 owner entry / version-run pointer / state / role limits; AC17 Q2 jump + focus; AC18 distinct save buttons; existing reply kept, draft revision 1, questions Open). Transient save notices not re-triggered — automated evidence (31 Oct) kept. Owner also saw "No AI model configured" on the running server.
- **Close of 1 Nov:** server stopped (leftover processes verified by command line and stopped; port 3000 free; not restarted); DB checkpointed and closed by SQLite, every table identical before / after, integrity ok, FK 0, schema v17; calls 0; switch off. Details and open items: `docs/setup-status.md` "1 Nov 2026 — end-of-day handover".
- **Copilot v1:** implementation plan `docs/copilot-plan.md` and case set `docs/copilot-cases.md` written (design only; no code, route, page, table or dependency added). **Revised after the owner's decisions (1 Nov):** five buttons, no free text; model explanation per button with citations (facts layer "not AI", MOCK labelled); ledger migration (next free number) + shared ledgered call + real adapter wiring **in the 3–4 Nov scope**; real calls only after authorisation of cases / count / cost cap; read-only fact reads (no INVALIDATED writes); re-authorisation after the model returns; late responses dropped; clear on sign-out / switch. Trade-offs if short: plan §9.2 — MOCK alone ≠ done.
- **Calls today:** model 0, token count 0, PayPal 0; payment switch off.

### Remaining schedule (re-checked 1 Nov; dates SGT; replaces the 3 Nov onward rows of "Schedule from 30 Oct" — those rows stay below as history) — superseded on 2 Nov by "Schedule from 2 Nov" above; kept as history

| Date | Step | Real state on 1 Nov | Done when |
| --- | --- | --- | --- |
| **1 Nov** | Resume check; owner UI confirmations A + B; Copilot plan + cases | baseline done; **A + B passed (owner)**; plan + cases written and revised (five buttons) | done |
| **2 Nov** | Finish Copilot preparation (remaining decisions: plan §9.2 trade-off order, Copilot limits §6.1, the real-run proposal §6.4 in principle); sort demo material (which records, which steps, SYNTHETIC only); **buffer** | buttons-only decided 1 Nov | decisions recorded; demo outline in docs |
| **3 Nov** | Copilot part 1 (server): read-only `readFacts` (G2), fact builder + facts layer for 5 intents, NEXT_STEP, links, digest, ask flow with re-authorisation, validator, MOCK fixtures, routes, unit/HTTP tests; **ledger migration rehearsed on a copy** | not started | CP1–CP5, CP7, CP9, CP11 automated (MOCK); no business write; migration rehearsal recorded |
| **4 Nov** | Copilot part 2: shared ledgered call + LIVE wiring (adapter double); migration applied (server stopped, backup + drill); panel (5 buttons, labels, outdated / gone, late-response drop, clear on sign-out / switch); `copilot.e2e` on a copy; owner check; **authorisation request for the real run** (cases, count, cost cap); real run on a copy **only if authorised** | not started | CP6 (MOCK), CP8, CP12; owner check; real-call evidence only if authorised. Without a real run: "built, MOCK-verified; real acceptance open" (not "done"). If short: plan §9.2, possibly the real run on 5 Nov morning |
| **5 Nov** | Deployment preparation (owner decides target, cost-checked, S$0 target); webhook `PAYMENT.CAPTURE.COMPLETED` **only if** a public URL exists | deployment **not started**, target **not decided**; webhook **never verified** | deploy smoke check, or "not done" recorded; webhook verified, or stays **not done** |
| **6 Nov** | Presentation polish (EN; 简体中文 labels if time — CP10 / G7); minimal record export **only if time** | export **not started (at risk)** | owner visual check |
| **7 Nov** | Final acceptance + **feature freeze** | — | nothing new after this |
| 8–10 Nov | Docs, README fresh-clone run, demo video (< 3 min), Devpost text | README fresh-clone run **not done**; E2E < 3 min **not done** | fresh clone → README → flow works |
| **11 Nov** | **Internal submission target**; 12 Nov buffer; official deadline 13 Nov 04:00 SGT | — | submitted |

**Kept with their real state (not dropped, not started, no new scope):** reference exchange rates + cost overview — deferred; tax / duty engine — not planned; A–D readiness grade — deferred, no date; full trade-sheet fee preview — deferred (approval money lists only); proof checklist, issue-handling summary — deferred; mailbox import and quote-file import — evaluation only, no build; evidence export — at risk (6 Nov only if time); webhook — not done; deployment — not started. Known issues unchanged without new evidence: thread-test segfault (open, cause unknown); browser-coverage gaps on old unowned records (not passed); `clarification.e2e`, `access.e2e`, `approval-payment.e2e` not re-run after the 31 Oct UI changes; temporary-file clean-up of earlier sessions as recorded there.

## Where the project stood (31 Oct 2026, SGT, end of day — handover)

- **HEAD:** this handover commit on top of `c870048` (local, not pushed); schema **v17**; tree clean; all project processes stopped, port 3000 free; main DB checkpointed (`-wal` 0), integrity ok, FK 0.
- **Kept:** 2 PAID Sandbox payments, the approval ↔ payment link, AI ledger (5 rows), earlier approval snapshots — existing rows identical to the pre-acceptance backup.
- **R-ACCESS-CLOCK (v17):** fixed, automated verification passed (not owner-verified as such); owner's R1 run shows GRANT → REVOKE → GRANT, old approval invalid, new approval on the new grant.
- **Usability round + approval-result fix:** owner re-check A–C passed; reply form (D) performed, not confirmed; step 1 performed, no issue reported. Approval-page intro corrected.
- **Limits:** `clarification.e2e`, `access.e2e`, `approval-payment.e2e` not re-run this round; old-record browser gaps; thread-test segfault (unchanged).
- **AI off depends on the start command** (`AI_PROVIDER=" " npm run dev`); a plain `npm.cmd run dev` may load the real model configuration from `.env.local`. Payment switch off.
- **Next:** Copilot 3–4 Nov (not started). Details: `docs/setup-status.md` "31 Oct 2026 — end-of-day handover".

## Where the project stood (31 Oct 2026, SGT, night, close — owner re-check A–C passed)

- Owner re-check A–C passed: approval result visible, v17 remove → re-assign → re-approve. D (reply form) performed by the owner, expected results not explicitly confirmed — not recorded as passed. Approval-page intro corrected (version + run from the link, latest-version check, no switch). Model config verified NOT_CONFIGURED with `AI_PROVIDER=" "` (depends on that start command). Payment switch off. **Next:** Copilot 3–4 Nov (not started). No push, no deployment.

## Where the project stood (31 Oct 2026, SGT, night, later — approval result made visible; owner re-check pending)

- **Owner acceptance paused at step 3:** the approver's approval was stored but not visible (no Active near the button, button still clickable). Fixed on the approval page only: "Approved — Active" read back from the server replaces the button while an approval is Active; "saved, refresh failed" if the read-back fails; server idempotency / one-active rule unchanged. `npm test` 417/417, lint, typecheck, build; `usability.e2e` 39/39, `approval.e2e` 17/17 (copy). The 404 after removing the approver is the accepted access rule; acceptance text corrected. **Next:** owner continues with steps A–D (`docs/setup-status.md` "31 Oct 2026 (night, later)"); then Copilot 3–4 Nov.

## Where the project stood (31 Oct 2026, SGT, night — usability to-dos built; owner acceptance pending)

- **R-ACCESS-CLOCK:** owner accepted the fix — recorded as **fixed, automated verification passed** (not owner-verified; earlier owner acceptances unchanged).
- **Usability to-dos built** (nothing beyond them; schema still v17): approval entry on the Quotes page (role-aware, explicit version + run, reasons when there is no basis); question card → supplier reply form; "Save clarification draft" vs "Save supplier reply" with notices naming the content. `npm test` 417/417, lint, typecheck, build; browser `usability.e2e` 32/32 (incl. v17 assign → approve → remove → re-assign → re-approve on a TEST record of a copy), `replies.e2e` 26/26, `approval.e2e` 17/17. **Owner acceptance pending:** five steps on two new [TEST] records (`docs/setup-status.md` "31 Oct 2026 (night)").
- **Next:** owner acceptance; then **Copilot 3–4 Nov** (not started). No push, no deployment.

## Where the project stood (31 Oct 2026, SGT, evening — access accepted; payment-authorisation defect R-ACCESS-CLOCK fixed, schema v17)

- **Access phase: accepted** (owner: five steps 30 Oct + re-check 31 Oct, both kept as passed). **New payment-authorisation defect found afterwards (R-ACCESS-CLOCK)** — owner decided to fix it, not accept it. **Fix built (v17) and verified by automated tests** (3 new tests failed on the old code — one reached PAID in MOCK after the approver was removed; all pass after the fix; `npm test` 412/412; build pass). Owner verification: not required (cases not producible by clicking); optional three steps on a new [TEST] record if wanted. Details: `docs/setup-status.md` "31 Oct 2026 (evening)".
- **Next step (owner decides):** usability to-dos — approval entry from the Quotes page, question-card pointer, Save vs Save reply. **Copilot stays 3–4 Nov.** No scope expansion.

## Where the project stood (31 Oct 2026, SGT, afternoon — access phase complete for the local demo [wording withdrawn in the evening]; mid-point review)

**Read first:** `docs/setup-status.md` → "31 Oct 2026 — access phase close-out".

- ~~**Access phase: COMPLETE for the local single-machine demo**~~ (withdrawn 31 Oct evening — see above) (31 Oct, one day before the 2 Nov acceptance slot). Owner: five steps passed (30 Oct) + the re-check after the approval / audit transaction fix passed (31 Oct). DB: one approval by the real approver with its `APPROVE` audit row, removal recorded, validity computed INVALIDATED (`APPROVER_UNASSIGNED`), payments and ledger unchanged. Automated: access 14/14, `npm test` 406/406. Migration evidence v15 / v16 complete. Browser checks: all 12 scripts under real sign-in; gaps on old unowned records listed (not passed).
- ~~**Open, not blocking the local demo:**~~ (withdrawn; fixed in v17) **R-ACCESS-CLOCK** — removal-after-approval is detected by comparing timestamps only; a backwards system-clock step between approval and removal would hide it. Fix proposed (grant sequence; no migration). **Must be fixed or explicitly accepted before any multi-user deployment.** Also unchanged: demo-level login throttling, no `Secure` cookie on local http, the 200 shell for an invalid cookie on pages.
- **Ahead of schedule ≠ more scope.** 1–2 Nov are freed. Proposal (owner decides): R-ACCESS-CLOCK fix + its test (½ day), the small usability to-dos (approval entry from the Quotes page; question-card pointer; Save vs Save reply), then buffer. **Copilot stays 3–4 Nov**; nothing new is started without the owner's go-ahead.

### Mid-point review (documents, 31 Oct)

**Built and owner-accepted (visual):** Sandbox payment loop with a real USD 1.00 payment (21 Oct); procurement requests, edit conflicts, revisions (22–24 Oct); stable item ids, immutable quote versions (23 Oct); buyer type, references, AI extraction with MOCK (24 Oct); search, value checks, API budget (25 Oct); real-model extraction on 5 SYNTHETIC samples — Anthropic, US$0.069710 (25 Oct); comparator C1–C7 (26 Oct); bilingual clarification draft (27 Oct); supplier reply tracking (29 Oct); approval condition snapshot (29 Oct); approval → payment loop preparation steps 1–3 (30 Oct); **real Sandbox USD 12.00 payment of an approval (AP12)** — owner saw PAID, independently verified (30 Oct); sign-in and object-level access, five steps (30 Oct) + re-check after the fix (31 Oct).

**Automated / MOCK only (never owner-checked or never real):** payment failure and unknown-outcome paths (AP3/4/6/9/10/11, AP14–19, MOCK PayPal); approval-payment flow in the browser (MOCK, on a copy); password reset ending sessions; budget concurrency (thread tests); clarification check details (CL6 etc.) and reply-tracking items marked automated in design R1–R14; 12 signed-in browser scripts (DB copies, MOCK model). The approval chain that was paid for real used a **MOCK** extraction — there is no real AI → payment chain.

**Not done:**

| Item | State | Plan |
| --- | --- | --- |
| AI Copilot CP1–CP12 | not started (design only) | **3–4 Nov** (MOCK model first; live calls only if the owner authorises) |
| Deployment / persistence | not started; target not decided | 5 Nov decision (R-ACCESS-CLOCK fixed 31 Oct, v17) |
| Webhook `PAYMENT.CAPTURE.COMPLETED` | never verified | 5 Nov with a public URL; otherwise stays **not done** |
| Evidence package / export | not started | **at risk** — minimal export on 6 Nov only if time remains |
| Exchange rates + cost overview, proof checklist, issue-handling summary, A–D grade, full trade-sheet fee preview | not started | **deferred** (not before the freeze) |
| End-to-end run with SYNTHETIC data < 3 min; README fresh-clone run | not done | 6–10 Nov |
| Quote-file import | evaluation only | evaluation note if time |
| Thread-test segfault | open, cause unknown | no new evidence; unchanged |
| Usability to-dos (approval entry from Quotes; question-card pointer; Save vs Save reply) | **built 31 Oct night**; automated + browser checks passed (copy) | owner acceptance (five steps) |

**Fixed dates kept:** feature freeze **7 Nov**, internal submission **11 Nov**, buffer 12 Nov, official deadline 13 Nov 04:00 SGT.

## Where the project stood (30 Oct 2026, SGT, late night, close — access acceptance passed; one re-check after the fix)

- **Owner acceptance (30 Oct):** all five access steps **passed** (owner), including removal → access refused and the approval invalid. Kept as historical acceptance.
- **Re-check after the fix (修复后待复验):** `2e4399a` (after the owner's check) put the approve / revoke / payment-start audit row inside the decision's transaction. The owner re-checks re-assign → approve → remove → *No longer valid* once (steps and links: `docs/setup-status.md` "30 Oct (late night, close)"). Not a reopened acceptance.
- **Remaining access-phase work:** browser scripts with real sign-in — done; audit-failure fix — done (2 tests, 406/406). **Blocking:** only the re-check above. Not blocking: 4 history-bound scripts not converted, demo-level login throttling, no `Secure` cookie on local http, the 200 shell for an invalid cookie on pages.
- **State at close:** server stopped, port 3000 free; DB v16 checkpointed and closed, unchanged; switch off; calls 0. Copilot not started. Schedule unchanged: Copilot 3–4 Nov, deployment decision 5 Nov, polish 6 Nov, freeze 7 Nov, submission 11 Nov.

## Where the project stood (30 Oct 2026, SGT, late night — before the close; the "open" wording is withdrawn)

- **Owner check (30 Oct):** steps 1, 2, 5 and the refusals passed. **Open:** "approver approves" and "removing the approver invalidates the approval" — no approval was saved during the check (stored data), so these were not seen; the owner repeats them (about 2 minutes). Password-reset session revocation: automated only.
- **Done since:** local password reset (schema v16; owner replaced the exposed passwords); browser checks sign in for real (8 scripts pass on a DB copy; `compare-clarify` new); approval audit made atomic with the decision (fixes "approval saved but reported as failed / audit lost").
- **Access phase — still blocking anything?** Only the open owner part above blocks calling the phase accepted. Not blocking (recorded): 4 history-bound browser scripts not converted (old records stay unowned by decision); demo-level login throttling; no `Secure` cookie on local http; the 200 shell for an invalid cookie on pages.
- **Copilot:** not started (waits for the open part). Schedule unchanged: Copilot 3–4 Nov, deployment decision 5 Nov, polish 6 Nov, freeze 7 Nov, submission 11 Nov.

## Where the project stood (30 Oct 2026, SGT, night — sign-in and object-level access built; owner acceptance open)

**Read first:** `docs/setup-status.md` → "30 Oct 2026 (night) — sign-in and object-level access built (schema v15)". Design / as built: `docs/access-control.md`.
- **Built (one day ahead of the 31 Oct – 1 Nov slot):** three preset accounts, server sessions, CSRF, owner / assigned-approver rules on every page and API, approver assignment, legacy approvals not payable, `/sandbox-demo` off, schema **v15** (rehearsed, restore-drilled, applied; existing data identical). 402/402 tests, build pass, browser 21/21 (four isolated profiles).
- **Open:** owner acceptance (five steps; step 1 = the owner sets the passwords). No account or ownership exists until then.
- **Not updated:** the older browser scripts (they stop at sign-in) — planned for 1 Nov.
- **Schedule effect:** none of the later dates moves earlier. The freed 1 Nov goes to acceptance fixes and to giving the older browser scripts a sign-in step. The Copilot still starts only after access is accepted (3 Nov).

## Where the project stood (30 Oct 2026, SGT — approval → payment loop prepared; real Sandbox waits for authorisation)

**Read first:** `docs/setup-status.md` → "30 Oct 2026 (evening) — handoff corrections and acceptance material" (PR-F9B23762 now has an Active approval; run counts; server check; owner steps). **Record:** `docs/setup-status.md` → "30 Oct 2026 — approval → payment loop prepared". As built: `docs/approval-design.md` §16. Matrix AP13–AP21, CP1–CP12: `docs/design-24oct-additions.md` §8.

**Done today (30 Oct):**
- **Plan updated with the mentor feedback** (`docs/product-brief.md` §1a, §4a, §8a, §11): narrower first customer (a hypothesis, not research); demo boundaries (fixed Sandbox test merchant, not any supplier's account, not escrow, no PayPal private data); less typing (one-time import as the goal; one quote-file format **to evaluate**, mailbox import later; nothing built); value validation (interview questions, SYNTHETIC USD 800 → +USD 180 = 22.5 % example, user-test metrics "not measured"); **AI Copilot formally planned** (not built).
- **Approval → payment loop built and verified with MOCK PayPal only:** server switch (off / sandbox on the main DB / mock on a copy), payment panel, read-only handling of unknown outcomes (no re-send even with a valid approval), seeded record for the real run. 392/392 tests, lint / typecheck / build pass, browser MOCK 11/11 + 5/5 after restart.
- **Later the same evening (authorised):** the real Sandbox USD 12.00 payment of PR-F9B23762 — **PAID**; owner saw PAID, server VERIFIED_PAID, independent Orders GET + capture GET 17/17; switch off again. Chain: MOCK extraction → reviews → human approval → real Sandbox payment (**not** a real AI → payment chain). Model calls 0.

## Schedule from 30 Oct (re-planned 30 Oct, completed 30 Oct evening; proposal — dates are SGT targets; the owner reviews each step)

Order (owner, 30 Oct): **approval → Sandbox loop → sign-in / object-level access → minimal Copilot → presentation polish.** A–D readiness stays a separate deferred item. Rows for 31 Oct onward in "Schedule (from 24 Oct)" below are superseded by this table and kept for history. **Migration numbers:** each migration takes the schema number that is actually free when it is executed; none is reserved (today the database is v14).

**Dependencies:**
- Real Sandbox loop ← owner's explicit authorisation (pending).
- Multi-user deployment ← sign-in + object-level access **accepted**.
- Copilot ← sign-in + object-level access accepted (it may read only records the principal may access; CP1, CP7).
- Webhook verification ← a public URL (deployment or tunnel) ← deployment decision.

| Date | Step | Depends on | Scope (and what is out) | Acceptance node |
| --- | --- | --- | --- | --- |
| **30 Oct** (done) | Approval → payment loop prepared (MOCK) + plan update | 29 Oct approval snapshot (accepted) | switch, panel, no re-send after unknown, seeded record | Owner check **passed 30 Oct** (steps 1–3); MOCK screenshots viewed only, not a payment acceptance |
| **31 Oct** AM | **Real Sandbox USD 12.00** of `PR-F9B23762` — **only after the owner's explicit authorisation**; read-only verification afterwards; then invalidate-after-payment check | owner check; authorisation; owner at the PayPal window | one record, one order, one capture; nothing else | AP12 (real Sandbox + owner evidence, kept apart from MOCK) — **done 30 Oct evening** (authorised; owner saw PAID; server VERIFIED_PAID; independent GETs 17/17); MOCK extraction basis, not a real AI chain |
| 31 Oct PM – 1 Nov (**built 30 Oct night**, schema v15 + v16; **accepted 30 Oct + re-check 31 Oct**) | **Sign-in + object-level access control** (design §6.4: Buyer A, Buyer B, Approver; server sessions; ownership / assignment; audit). Migration: backup + rehearsal on a copy first, number = next free at execution | owner go-ahead; owner's choice for existing records (`docs/access-ownership-candidates.md`) | every route via `policy.ts`; `canApproveRequest` → assigned approver, `canPayRequest` → owning buyer. Out: registration, password reset, supplier login | A5, A6, A10 (that migration) — automated by 1 Nov |
| **31 Oct – 2 Nov** (owner's choice of day; **access accepted and mid-point review done 31 Oct** — 1–2 Nov freed, use is the owner's decision) | Access-control owner acceptance + **mid-point acceptance** (moved from 31 Oct); 1 Nov also: fixes from the acceptance and a sign-in step for the older browser scripts | 31 Oct – 1 Nov | two buyers in two browser profiles; approver sees only assigned records | A5, A6 owner; A1–A8, A10 accepted or listed open with reasons. **If not accepted:** Copilot and deployment move back; no multi-user deployment |
| **3 Nov** | **Minimal Copilot, part 1 (server):** record-scoped context builder through the policy; facts only from the comparison, approval gate, money lists, reply facts and payment records; citations (version, revision, run, excerpt); no write path; quote / reply text as untrusted data; budget purpose in the v9 ledger; **MOCK model only** | 2 Nov accepted | explanation of differences / blocked approval / unresolved replies / this payment's amount; next-step links. Out: general chat, actions, other records | CP1–CP5, CP7–CP9, CP11 automated (MOCK model) |
| **4 Nov** | **Minimal Copilot, part 2:** side panel on the record pages (EN first, 简体中文 secondary), no call on refresh; injection fixtures; owner check with the MOCK model. **Real model calls only if the owner authorises them** (number and limit set by the owner; same provider and ledger) | 3 Nov; authorisation for live calls | — | CP6, CP10, CP12; owner check; ledger before / after |
| **5 Nov** | **Deployment preparation:** owner decides target (cost-checked, S$0 target); if A5 / A6 are accepted, deploy one instance and register / verify the webhook `PAYMENT.CAPTURE.COMPLETED`; if not, prepare the local single-user demo (README run path) and leave the webhook open | 2 Nov; deploy decision | deploy + webhook only; no new features | deployment smoke check; webhook verified **or** recorded as not done |
| 6 Nov | **Presentation polish:** EN / 简体中文 switching, zh labels on the approval page, readability; small to-dos (question-card pointer, Save vs Save reply); scenario run with SYNTHETIC data | — | polish only | A9; owner visual check |
| **7 Nov** | **Final acceptance and feature freeze** (kept) | all above | nothing new after this | — |
| 8–10 Nov | Docs, English demo video (< 3 min), Devpost text | freeze | — | fresh clone → README → flow works |
| **11 Nov** | **Planned (internal) submission target** (kept); 12 Nov buffer; official deadline 13 Nov 04:00 SGT | — | — | — |

**Owner-side, in parallel (not assistant work):** exploratory buyer interviews (questions in product brief §11). Results are recorded only when they exist; until then every metric stays "not measured".

**Items of the original plan (24 Oct schedule) — status, none silently dropped:**

| Item (original date) | Status on 30 Oct | Plan |
| --- | --- | --- |
| Real Sandbox payment of an approval (29–30 Oct) | **done 30 Oct evening** (USD 12.00 PAID, verified; see setup-status) | — (failure paths stay MOCK-only) |
| Access control (28 Oct → 31 Oct) | **built 30 Oct night** (v15, v16 reset); **owner-accepted 30 Oct** (five steps); audit fix `2e4399a`; **re-check passed 31 Oct**; R-ACCESS-CLOCK found and **fixed 31 Oct evening (v17, automated)** | usability to-dos next |
| Mid-point acceptance (31 Oct) | **document review done 31 Oct** (top of this file) | owner reads it; no scope change implied |
| Deployment, persistence (1–2 Nov) | not started; deploy target not decided | 5 Nov, only after access control accepted |
| Webhook `PAYMENT.CAPTURE.COMPLETED` (1–2 Nov) | not done (never verified) | 5 Nov with deployment; otherwise stays **not done** |
| Reference exchange rates + cost overview (3 Nov) | not started | **deferred** — no slot before the freeze; owner decision |
| Scenario document checklist, payment proof (4 Nov) | not started | **deferred**; payment ids / status already shown on the approval page |
| Evidence package / export of one record (4 Nov) | not started | **at risk**: only a minimal export (versions, approval, payment ids; access-checked) if time remains on 6 Nov; otherwise not done |
| Issue-handling summary (4 Nov) | not started | **deferred** (not before the freeze) |
| Scenario tests, feedback, EN / 简体中文 (5–6 Nov) | catalogue EN only | 6 Nov (polish); test-user feedback depends on the owner's interviews |
| A–D readiness grade (29–30 Oct) | deferred, not done | no date; not replaced by the gate or the Copilot |
| Full trade-sheet fee preview (29–30 Oct) | approval money lists only | deferred |
| Quote-file import (new, 30 Oct) | evaluation only | evaluation note if time; no build |
| Mailbox import, supplier portal | later directions | not scheduled |
| Thread-test segfault | open, unfixed | `docs/diagnostics/budget-threads-segfault.md` |

## Where the project stood (29 Oct 2026, SGT, end of day — approval snapshot owner-accepted)

**End-of-day handoff:** `docs/setup-status.md` → "29 Oct 2026 — end-of-day handoff". Server stopped; DB v14 checkpointed and closed.
- **Next (30 Oct):** prepare the approval → PayPal Sandbox closed loop using a **new valid approval** — A's original approval stays invalid and C's stays revoked; neither is reset or reused. Enabling payment steps and the real USD 12.00 Sandbox transaction each need the owner's explicit authorisation first.
- **Then:** sign-in and access control (prerequisite for multi-user deployment); the A–D readiness grade. A migration takes the next actually free schema number at the time it is written (today v15; not reserved).

**Approval condition snapshot and version binding: built (schema v14); the owner's five manual steps passed (confirmed 2026-10-29 SGT).** Record: `docs/setup-status.md` → "29 Oct 2026 — owner accepted the approval snapshot". As-built rules: `docs/approval-design.md` §15. Matrix AP1–AP12: `docs/design-24oct-additions.md` §8.
- **Owner-seen and passed:**
  - A approved, a repeated click still gives one approval;
  - B and the deposit sample blocked;
  - C needs both confirmations, then approved and revoked;
  - A edited then reverted stays invalid;
  - the stored snapshot is kept in the history (USD 12.00 = 1200 cents).
- **Automated or MOCK only (not owner acceptance, not a real payment):** concurrency and stale or mismatched previews (AP6); tamper refusals and other blocking rules (AP3, AP4, AP10); payment state machine with the MOCK PayPal gateway (AP9); migration (AP11).
- **Not done:**
  - the real approval → PayPal Sandbox loop;
  - sign-in and access control;
  - the A–D readiness grade.
  - The real Sandbox USD 12.00 transaction is **still not authorised**; payment steps over HTTP stay 409.

**Built earlier the same day (afternoon):**
- **Owner decisions confirmed (29 Oct):**
  - one full payment of the stated USD total;
  - over budget blocks;
  - assigned approver approves, owning buyer pays;
  - local loop first, multi-user deployment only after access control is accepted.
- **Built:** preview / gate, immutable snapshot + digest-bound confirmations, atomic approve, terminal invalidation / revoke, requirement classification, policy entry points, payment module bound to the snapshot (guard inside the create / capture transition).
- **Evidence:** 380/380 tests (33 new), lint / typecheck / build pass, browser 17/17 (run 1 16/17, check fixed), migration rehearsed + applied with backups.
- **Payment: MOCK PayPal integration tests only.** HTTP payment steps for approvals return 409 in this phase. The real Sandbox USD 12.00 payment of Example A is **not authorised**.
- **Still not done:**
  - **access control** — prerequisite for multi-user deployment; 31 Oct morning slot;
  - **A–D readiness grade** — deferred, not done;
  - zh-CN approval labels.
- **Small to-dos kept:** pointer from question cards to the reply form; Save vs Save reply wording.
- **Next free schema number:** v15 (not reserved).

## Where the project stood (29 Oct 2026, SGT — approval design written, waiting for the owner's review)

**Approval condition snapshot and version binding: design only — `docs/approval-design.md`.** No application code, no migration, no model / PayPal call.
- **Baseline re-checked read-only:** `b577cbb` clean, schema v13 (integrity ok, FK 0), LIVE 5 / MOCK 16 / 0 running, ledger 5 / US$0.069710, PAID USD 1.00 / 10 events, port 3000 free.
- **Design in short:**
  - the server re-computes the comparison and a BLOCK / WARN / INFO gate;
  - an immutable snapshot bound to request revision + relevant-field fingerprint, version + hash, run, reviews digest, statements digest, payee fingerprint and rules versions;
  - four separate money figures; v1 = one full payment of the stated USD total;
  - validity checked from append-only facts since approval (invalid is terminal, no auto-recovery);
  - capture is the decision point (validity check + `CAPTURING` in one transaction; no PayPal call inside a lock);
  - `canApproveRequest` / `canPayRequest` in `policy.ts`.
- **Reusable modules, new data (v14 when written: `approvals`, `approval_events`, `approval_payments`), routes and order:** design §10. The migration follows the usual procedure (`VACUUM INTO` backup → rehearsal on a copy → real DB) and is **not** run in this round.
- **Revision 2 (owner review, 29 Oct):**
  - main line accepted;
  - key attributes without supplier basis block (no tick);
  - only the latest complete conditions of a series are approvable (supplement = itself + explicit full base);
  - edit-then-revert stays invalid (append-only event basis);
  - payment-state boundaries with no promise to cancel a sent payment;
  - landed cost "not calculated in this version" with excluded / unknown / unverified lists;
  - deterministic digest with confirmations bound to it;
  - A–D grade **deferred** (not done);
  - USD 100 ceiling is a technical limit, not an authorisation. Real Sandbox acceptance uses Example A (USD 12.00) with the owner's go-ahead.
- **Recommended decisions awaiting the owner's confirmation** (design §11):
  - one full payment of the stated USD total;
  - over budget blocks (change budget → re-review);
  - assigned approver approves, owning buyer pays;
  - local loop first, multi-user deployment only after access control is accepted.
- **Schedule impact:** build starts after the review. 30 Oct = library → migration → service / HTTP → page → MOCK payment → seed + browser check; owner acceptance and the one real Sandbox payment may spill into 31 Oct morning, which competes with access control (design §10.4).
- **Not part of this work (small to-dos, kept separate):** pointer from question cards to the reply form; Save vs Save reply wording.

## Where the project stood (28 Oct work — closed early 29 Oct 2026, SGT)

**Handoff:** `docs/setup-status.md` → "28 Oct work — closed early 29 Oct 2026 (SGT): end-of-session handoff".
- **Done and owner-accepted:** supplier reply tracking with stable question numbers (owner, 2026-10-29 SGT).
- **Not done from the 28 Oct row:** access control (sign-in, object-level checks, assignment of existing records) — not started.
- **Not started:** approval condition snapshot / version binding, fee preview, approval → payment loop.
- **Next:**
  1. **Approval condition snapshot and version binding** — design for the owner first. The server re-checks the quote version, a server-side comparison and the stored reviews at approval time; opening the comparison page is never taken as evidence.
  2. **Access control** before any multi-user deployment (31 Oct morning slot per the confirmed schedule, else open at the mid-point). Existing records are not assigned to Buyer A by default.
- **Migration numbers** are assigned when written (next free v14), none reserved.
- **Resource rules in force:** no builds / stress series during manual acceptance. No test or build concurrency settings have been changed.

**Supplier reply tracking: complete.**
- **Owner-accepted 2026-10-29 (SGT):** five steps on `PR-6117B2A1`; owner-seen vs automated-only in design R1–R14.
- Built 28 Oct across schemas v11–v13 (commits `5d93915`, `7114eac`, `21ea38d`, times as logged).
- Known limits unchanged (`docs/supplier-replies.md`).

**Next phase: approval condition snapshot and version binding** (from the 29–30 Oct row; starts only on the owner's go-ahead).
- **Snapshot and binding:** the approval is bound to one quote version + request revision and records an immutable snapshot of the conditions approved.
- **Allowed sources:** only terms from a quote version that was extracted on current rules, compared, and reviewed by the buyer.
- **Refused on the server:** approval from reply statements, from an unverified "updated quote" link, or after the basis changed.
- **Fee preview / readiness and the Sandbox payment loop** follow the approval, as already planned. Amounts come only from the locked approval.

**Access control remains the prerequisite for any multi-user deployment** (design §6.4, owner's sign-in decision; ownership list `docs/access-ownership-candidates.md`, nothing assigned). Schema number = next free when written.

**Earlier (29 Oct, early SGT):**

**29 Oct — reply tracking, second review (owner request):**
- **Built (v13):**
  - same request key replays / other payload refused / identical text under a new key kept as a separate reply (possible duplicate, not merged);
  - answer basis extended to the sent draft revision, the draft's run, the newest run and the reviews;
  - four separate facts (received · reviewed · quote update · not approved);
  - statements classified (confirms the quoted condition / new condition / cannot judge);
  - linked updated quote shown as not extracted / compared / approved;
  - browser check repeatable on a seeded `[TEST]` record per run.
- **Checks:** 347/347 tests; production build PASS; browser 26/26 on the final script + 6/6 after restart; sensitive-content scan 0 matches.
- **Owner acceptance open** (five steps on `PR-6117B2A1`).
- **Access control:** not started; record list and the owner's recommended ownership scheme in `docs/access-ownership-candidates.md` — nothing assigned.
- **Approval → payment:** not started.
- **Approval step requirement (29–30 Oct):** the server must refuse to approve on reply statements. It may approve only a quote version that was extracted (finished run on current rules), compared, and reviewed. `ReplyService.updatedQuoteStatus()` and `buyerStatements()` (`usableAsApprovedTerm` / `usableAsPaymentAmount` always false) are the inputs to check.

**28 Oct night — review and fix (owner request):** reply tracking checked against the authorised requirements (gap table in `docs/supplier-replies.md`).
- **Fixed as schema v12:** replies are kept apart from quote versions; copied text carries `[Qn]` + the draft reference; source / unverified-sender labels; unassigned replies; contradictions; corrections; per-answer basis (not inherited); "buyer statement" + "updated quote needed", never an approved term.
- **Checks:** 343/343 tests, production build PASS (run once with the dev server stopped), browser 19/20 (the 20th a `data:` icon false alarm, diagnosed) + 5/5 after restart.
- **Owner acceptance open**; earlier acceptances unchanged.
- **Demo sign-in decided** (three preset accounts, server session) → access-control plan in design §6.4, schema **v13**, not started.
- No approval / payment code started, nothing pushed or deployed.

**28 Oct:** supplier reply tracking + fixed question numbers on draft cards **built and assistant-tested; owner acceptance open** (`docs/supplier-replies.md`; `docs/setup-status.md` → "28 Oct 2026 — supplier reply tracking"). **Schema v11** (replies + answers, rehearsed, backed up, applied). Access control → ~~v12~~ **v13** (v12 used by the night fix), not started → **31 Oct morning** (approval → payment keeps 29–30 Oct). Model / PayPal calls 0, ledger unchanged. Demo sign-in: decided 28 Oct night (design §6.4).

**27 Oct end of day:** handoff in `docs/setup-status.md` → "27 Oct 2026 — end-of-day handoff" (server stopped, DB v10 checkpointed and closed, ledger 5 / US$0.069710, PAID USD 1.00, calls 0). **Next (28 Oct, after the owner's go-ahead): supplier reply tracking together with stable, readable question numbers on draft cards, then access control** (demo sign-in method still the owner's decision; migration numbers by the actual next free version, none reserved). Open: thread-test segfault (not fixed), page slowness (not reproduced).

**27 Oct:** bilingual clarification draft + deterministic English ↔ 简体中文 check **built and assistant-tested; owner-accepted 27 Oct evening (five manual steps)**: CL1, CL3, CL4, CL5, CL7 in their owner-seen parts; CL6 and the other automated-only parts stay automated (`docs/clarification-drafts.md`; `docs/setup-status.md` → "27 Oct 2026 (evening) — owner accepted the bilingual clarification draft"). Templates only — no model, no translation service, no spend (ledger still 5 rows / US$0.069710). **Schema v10 = clarification drafts** (next free number; backed up, rehearsed on a copy, applied, existing rows unchanged). **Access control therefore moves to v11** (28 Oct row). Supplier reply tracking **not started** (stopped at the owner's acceptance as instructed) → 28 Oct morning, as the confirmed schedule already allows. AI semantic translation check and full quote translation: not built (need the owner's go-ahead).

## Where the project stood (26 Oct 2026)

**26 Oct:** the comparator is wired to stored extraction runs (requirements 1–7, rows C1–C7 built and tested by the assistant; **owner acceptance open**). No model call, no spend, schema still v9. Bilingual clarification moved to 27 Oct (see "26 Oct outcome"; **shift confirmed by the owner 26 Oct**, approval → payment loop priority kept; 28 Oct access-control impact recorded there). Handoff: `docs/setup-status.md` → "26 Oct 2026 — comparator on stored extractions". **26 Oct evening (reliability, no new features):** budget-test database lock fix merged and in effect; RUNNING-after-failed-reservation fixed (`BUDGET_UNAVAILABLE`); a rare test-process segfault stays **open**; page slowness not reproduced (cold compile + machine load measured, no code change) — `docs/setup-status.md` "26 Oct 2026 (evening)". **26 Oct night: owner accepted C1–C7** (five-step visual check; automated-only parts stay labelled automated — "26 Oct 2026 (night)"); slowness: not reproduced, keep observing. **Next: 27 Oct as planned.**

## Where the project stood (25 Oct 2026, end of day)

Handoff: `docs/setup-status.md` → "25 Oct 2026 — end-of-day handoff" (final state: schema v9, clean tree, server stopped, 5 real calls / US$0.069710 local estimate; next: comparator per C1–C7, no new model calls). The 24 Oct state below is kept; 25 Oct changes are in the rows marked 25 Oct.

| Area | State |
| --- | --- |
| Local environment, lint / typecheck / build, local Git | Done |
| PayPal Sandbox payment base (create → buyer approval → capture → server verification, idempotent retries) | Done. **Real Sandbox:** one USD 1.00 payment verified (`docs/payment-validation.md` §5). **Mock only:** concurrency race, capture timeout / unknown outcome, retention-window cut-off, crash recovery, mismatch handling (§7). Not every payment failure has been tested against real Sandbox |
| Procurement request drafts (schema v4–v5) | Done; owner accepted 22–23 Oct |
| Stable item ids, immutable quote versions + request snapshots (schema v6) | Done; owner accepted 23 Oct (below) |
| Schema v7: buyer type, Request ID label, Item references, supplier-number and extraction tables | Done and applied to the local DB (24 Oct); **accepted by the owner 24 Oct** |
| AI extraction of a saved quote version (evidence, fees, item-match proposals, review, limits) | Built; owner accepted the flow **with the labelled MOCK only** (24 Oct). **25 Oct night: real model connected (Anthropic `claude-sonnet-5-5`), 5 SYNTHETIC real-model runs, US$0.069710 local estimate — accepted by the owner (`docs/live-model-acceptance.md`).** Before that: no real model connected (provider / model / spend not approved) → real-model extraction and acceptance **not done**. **25 Oct:** number-aware value checks (rules `value-check-2026-10-25.1`) and the overall API budget (schema v9) are built and mock-tested — the two code blockers are closed; owner acceptance of them is open |
| Search (25 Oct) | Built for local dev: Request ID / `PR-` / `QS-` / supplier numbers in every version / titles / quote names (design §3.2a). **Evening follow-up:** category filter, date sort, true match counts, search-only layout (owner feedback). Owner acceptance: step 1 open, step 2 counts passed / display re-check open |
| Deterministic comparator | **26 Oct: wired to stored extraction runs** — page `/procurements/:id/quotes/compare`, GET API, binding / ownership / older-rules refusal, item pairing by line id, reviews and corrections, open costs and conditions, supplements via the linked base (`docs/quote-comparison.md`). Assistant-tested (28 tests on the stored LA runs + temp DBs, 11/11 mutations, browser 20/20 + 15/15); **owner-accepted 26 Oct night** (five-step visual check). Before: library + adapter from checked extractions (`toComparatorQuote`); not run on stored extractions (25 Oct) |
| English string catalogue | Pages changed on 24 Oct only (`src/i18n/en.ts`); no zh-CN, no switching |
| Unchanged saves; request revision history (schema v8) | Built 24 Oct after the owner's acceptance found that unchanged saves increased the revision; **accepted by the owner 24 Oct** |
| Bilingual clarification draft + deterministic EN ↔ 简体中文 check (schema v10) | **27 Oct: built, assistant-tested** (28 unit / service / HTTP / migration tests, 8/8 mutations, browser 22/22 + 6/6 after restart). **Owner-accepted 27 Oct evening** (five steps; automated-only parts listed in setup-status). `docs/clarification-drafts.md` |
| Approval → payment flow, webhooks, deployment, full multi-language, AI translation check, full quote translation, access control, supplier reply tracking | Not done (comparator on stored extractions: done 26 Oct; clarification draft: built 27 Oct, above) |

## Done

| Date | Step | Evidence |
| --- | --- | --- |
| 21 Oct | Phase 0 setup: reproducible project, lint / typecheck / build, local Git | `8522827`, `docs/setup-status.md` §1 |
| 21 Oct | Phase 1 Sandbox payment spike; one real USD 1.00 Sandbox payment | `9f5e253` … `7e598d3`, `docs/payment-validation.md` |
| 22 Oct | Procurement request drafts: form, items, list / detail / edit, revision conflicts, short reference, stored data source (schema v5) | `2b97d85` … `05e5f99`, `docs/procurement-requests.md` |
| 23 Oct | Deterministic quote comparator + extraction schema with verbatim source per field | `9300eda`, `docs/quote-comparison.md` |
| 23 Oct | Stable item ids; quote import (pasted text) and immutable quote versions with request snapshots (schema v6) | `499148f`, `docs/quotes.md`; automated results recorded 23 Oct in `docs/setup-status.md` (128/128 tests, e2e 26/26 → 8/8 after restart → 27/27) |
| 24 Oct (late) | Fix: an unchanged save no longer creates a revision. Request revision history (schema v8, baseline for existing requests, no invented history) | This day's second commit; `docs/procurement-requests.md`, `docs/setup-status.md` (187/187 tests, 6/6 mutations, migration 26/26 on copy and real DB, browser 18/18 + 4/4 after restart) |
| 25 Oct | Number-aware value checks + new wording; overall API budget (schema v9, ledger); search; supplement-context regression test | This day's commit; `docs/quote-extraction.md`, `docs/design-24oct-additions.md` §3.2a, `docs/setup-status.md` (240/240 tests, 11/11 mutations caught, migration 23/23 copy + 21/21 real, browser 14/14 + 16/16 MOCK + 14/14 after restart). **Mock-tested only; owner acceptance open; no real model** |
| 26 Oct | Comparator on stored extraction runs (C1–C7): computed on demand, no schema change, no model call | This day's commit; `docs/quote-comparison.md`, `docs/setup-status.md` (tests 292/292 incl. 28 new, 11/11 mutations, browser 20/20 MOCK-server setup + 15/15 read-only after restart). **Assistant-tested; owner acceptance open** |
| 24 Oct | Schema v7 (buyer type, Request ID, Item reference, supplier-number + extraction tables); AI extraction pipeline with MOCK / not-configured states; English catalogue for touched pages | This day's commit; `docs/quote-extraction.md`, `docs/setup-status.md` (176/176 tests, 9/9 mutations caught, migration 35/35 on copy and real DB, browser 16/16 + 17/17). **Waiting for owner acceptance; real-model check not done** |

### 23 Oct owner acceptance — passed

The owner confirmed on 24 Oct that these five operations work (recorded from the owner's statement):

1. Edit items, change quantity, reorder, save.
2. Quote v1 preview and save.
3. Add v2; v1's original text unchanged.
4. Editing the current request does not change the request snapshot linked to the old quote.
5. After a restart, requests, quote versions and historical snapshots are still there.

Item ids are **not** a formal, visible reference yet: the editor and the quote snapshot show only a small grey `line xxxxxxxx` label and the read-only detail page shows none. Item id stability therefore rests on the automated checks of 23 Oct (unit tests, migration check, e2e), not on the owner having compared ids by eye. A visible **Item reference** (`IT-…`) is a usability improvement scheduled for 24–25 Oct; it does not reopen this acceptance.

### What `9300eda` gives later steps

| Reused as is | Not wired yet / gaps |
| --- | --- |
| `src/lib/quote.ts`: `ExtractedQuote` (incl. `quoteNumber`, `quoteDate`, `extraCharges` as `Sourced<…>`), `unverifiedSources()` (rejects excerpts not in the text), request parsers, `comparableFromRecord()` (accepts a stored record, so also a v1 snapshot's `record`) | No AI produces `ExtractedQuote` yet; only two hand-written reference extractions |
| `src/lib/quote-compare.ts`: `compareQuote()` and its rules (`docs/quote-comparison.md`), 6 seeded findings on synthetic data | Not run on stored quote versions; findings not stored; no page |
| `samples/synthetic/extracted-quote-*.synthetic.json` as expected output for evaluating the AI step | Items are matched **by position**; `ComparableRequestItem` carries no item id → add item-id matching when wiring (25 Oct). Full fee lines (payer, payee, included, stated as, basis) exist since 24 Oct in `ExtractionResult` (`src/lib/extraction.ts`); the comparator still sees only `ExtraCharge` |

## Schedule (from 24 Oct)

> **30 Oct:** rows from 31 Oct onward are superseded by "Schedule from 30 Oct" above (kept unchanged for history).

Each row: prerequisite → build date → acceptance date. Everything from 24 Oct on is **not started** unless stated.

| Date | Step | Prerequisites | Main acceptance (matrix ids: `docs/design-24oct-additions.md` §8) |
| --- | --- | --- | --- |
| **24 Oct** (done except real-model acceptance — see "24 Oct outcome" below) | **(a) Docs sync.** **(b) Main line: runtime AI quote extraction** into `ExtractedQuote`, bound to a quote **version id**, incl. cost lines and supplier-quote-number candidates with evidence; records model / prompt version and user corrections; assistant panel skeleton on real data only. **(c) Base improvements:** schema v7 (buyer type, supplier quote number facts, quote rename log, search keys), Request ID label, Item reference display, English string catalogue | (b) owner chooses the runtime model provider, how credentials are stored (`.env.local`, never committed) and an initial spend limit **before any real call**. (c) v7 migration rehearsed on a copy first | (b) output passes `unverifiedSources`; every field shows its source; reviewed against the reference extractions. (c) A1, A2, A10 (v7) build; A9 catalogue part |
| | *If 24 Oct overflows:* order is (b) → v7 migration + buyer type + references → catalogue. What is not finished moves to 25 Oct morning and is reported as not done; (b)'s acceptance is not reduced | | |
| 25 Oct (done except comparator wiring, rename log, number at save, real model — see "25 Oct outcome") | **First the resume order above (number-boundary fix → overall budget control → real model if approved → search).** Then: wire the existing comparator to persisted evidence (extraction of a version, request snapshot / revision), with item-id matching from the user-confirmed matches and stored findings. Request / quote search (+ quote rename log, supplier quote number entered at save time; next free schema version, v9, only if stored search keys are needed). Search does not cover the contents of request revisions, but it **must** find supplier quote numbers in every quote version, including earlier versions (design §3.1, A3). **Before any real call:** fix the number-boundary check and add the overall API budget control. **If the owner has approved a provider:** then add the live adapter and run the real-model acceptance from 24 Oct. 25 Oct is now heavier, and anything left over is reported, not dropped | 24 Oct (b), v7; provider decision for the real-model part | 6 seeded findings from the stored demo extraction, each naming version and request revision; A3, A4 build; real-model outputs reviewed by a person against the hand-written expectations |
| 26 Oct (comparator done; clarification moved to 27 Oct — see "26 Oct outcome") | **First (moved from 25 Oct):** wire the comparator to persisted evidence per "Next phase: comparator" (requirements 1–7; acceptance C1–C7) — only results checked with the current value rules, item-id matching from user decisions, user corrections used with originals kept, open items as needs clarification, no new model calls. **Then:** bilingual clarification draft (copy only, no auto-send); Translate-into selection; original / translation / side-by-side; **deterministic** translation check (no model needed), Chinese ↔ English first. The **AI** translation check only after the owner approves a provider (same budget mechanism) | 25 Oct value checks; provider decision for the AI part | 6 seeded findings from a stored (current-rules) demo extraction; A7, A8 build (AI part may stay open) |
| **27 Oct** (proposed 26 Oct; **confirmed by the owner 26 Oct**; starts only after the owner's C1–C7 result) — **27 Oct result: first part built (schema v10), **owner-accepted 27 Oct evening**; reply tracking not started → 28 Oct morning** | **First (moved from 26 Oct):** bilingual clarification draft built from the comparison's questions (copy only, no auto-send); Translate-into; original / translation / side-by-side; **deterministic** translation check, Chinese ↔ English first. AI translation check only with the owner's go-ahead (same approved provider and budget). **Then**, if time remains: supplier reply tracking and term confirmation; otherwise it starts 28 Oct morning | Comparator (26 Oct, built; **owner-accepted C1–C7 26 Oct night** — prerequisite met) | A7, A8 build (AI part may stay open); reply saved as new version or supplement; user marks confirmed terms |
| ~~27 Oct (original row)~~ | ~~Supplier reply tracking and term confirmation~~ — merged into the 27 Oct row above (second part), overflow to 28 Oct morning | — | — |
| **28 Oct** (updated 26 Oct, owner-confirmed shift; **27 Oct: reply tracking not started → it is the first task, with stable question numbers on draft cards**) | **Morning, only if 27 Oct did not finish it:** supplier reply tracking and term confirmation (reply saved as new version or supplement; user marks confirmed terms). **Then: roles and object-level access control** (next free schema version — v9 is the API budget ledger and **v10 is the clarification drafts (27 Oct)**, so ~~expected v11~~ → **v13** after the 28 Oct reply-tracking versions v11 / v12 (design §6.4: three preset accounts, server session): principals, sessions, owners / assignments, audit; the v11 migration must also cover `clarification_drafts` / `clarification_draft_revisions`, which already go through `canReadRequest` / `canWriteRequest`) covering lists, search, history, export, AI context. Plugs into `src/server/access/policy.ts` (24 Oct entry point used by extraction routes; 25 Oct `requestScope()` used by search, applied before LIMIT). **If the morning is used:** access control has about half a day; order inside it: v11 migration (rehearsed on a copy) → enforcement on request lists / detail / history, search, quotes, extraction and comparison (incl. AI context) → audit rows. Not finished on 28 Oct → **31 Oct morning, before the mid-point acceptance**, not 29 Oct (the approval loop keeps its days); export checks are built with the export itself (4 Nov). Anything still missing is reported open at the mid-point | Auth method for the demo decided (owner, §5.4 in setup-status) **before 28 Oct**; 27 Oct row | A5, A6, A10 (v8) build — **may be partial on 28 Oct** if the morning goes to reply tracking; completion 31 Oct morning |
| 29–30 Oct (**priority kept**: starts 29 Oct morning even if access control is not complete) — **29 Oct: design written and then built (schema v14, MOCK payment tests only); owner accepted the five manual steps 2026-10-29 SGT. 30 Oct: prepare the approval → Sandbox loop with a fresh valid approval; the real USD 12.00 payment waits for the owner's authorisation; A–D readiness grade **deferred, not done** (design §10.4); revision 2 after owner review** | Fee preview (trade sheet), approval bound to a version + request revision, A–D readiness, approval → Sandbox payment closed loop | 27 + 28 Oct | Pay button only for an approved record; amount from the locked approval; readiness and fee preview shown before paying. Approval and payment routes go through `policy.ts` from the start, so they are covered when v10 is complete |
| **31 Oct** | *(Morning, only if needed: access-control leftovers from 28 Oct.)* **Mid-point acceptance**: core flow end-to-end with synthetic data; new references, search, translation check and access control | all above | A1–A8, A10 accepted or listed as open with reasons |
| 1–2 Nov | Deployment (hosted, cost 0, or tunnel), persistence, webhooks | 28 Oct access control (no multi-user deployment without it); deploy target decided (owner, cost-checked) | `PAYMENT.CAPTURE.COMPLETED` verified and attached |
| 3 Nov | Reference exchange rates and cost overview | 29–30 Oct fee preview | Rates labelled reference with source and time; never change a payment amount |
| 4 Nov | Scenario document checklist, payment proof, evidence package / export, issue-handling summary | 28 Oct (export is access-checked) | Export of one record with versions, approvals, payment ids; export refused for other buyers |
| 5–6 Nov | Scenario tests, feedback and fixes; **complete EN / 简体中文 UI switching**; AI extraction readability polish (summary, items to review, next action first; evidence expandable; rule versions de-emphasised; warnings / unknowns / candidate vs confirmed / MOCK labels kept clear) | catalogue from 24 Oct | Fee accuracy, false / missed findings, feedback records checked with test users; A9 accepted |
| **7 Nov** | **Final acceptance and feature freeze** | — | — |
| 8–10 Nov | Docs, English demo video (< 3 min), Devpost text, materials check | — | Fresh clone → README → full flow works |
| 11 Nov | Planned submission | — | Repo public with OSI licence, video, description submitted |
| 12 Nov | Buffer | — | — |

New features are spread across the days above; none is packed into a single day beyond what the row says. A day that slips is reported, not marked done.

### 24 Oct outcome

- Done and tested: v7 migration (backup → rehearsal on a copy → real DB), buyer type, Request ID, Item references with copy, snapshot v2, the extraction pipeline (server-side input, evidence checks, fees, item matching, supplements, prompt boundary, limits, idempotency, single-flight, reviews, supplier numbers), MOCK and not-configured UI, and the English catalogue for touched pages.
- Not done: **real-model call and acceptance** (provider, model and spend not approved; no adapter). Entering a supplier quote number in the composer, rename log and search keys move to 25 Oct with search. zh-CN catalogue and switching stay on 5–6 Nov.
- Scope adjustments (minimal, documented): v7 holds only what 24 Oct needed; the DEMO_SAMPLE → BUSINESS back-fill was dropped (no evidence); access control takes the next free schema version, not a reserved "v8".
- Cost: S$0 today, S$0 cumulative.
- Owner acceptance of 24 Oct: **passed** (owner). **Scope of the owner's confirmation (24 Oct):** the five 24 Oct steps — Business / Individual fields, save and refresh; Item reference copy with ids kept after rename, quantity change and reorder; the honest "No AI model configured" state; extraction with the labelled **MOCK** on the original SYNTHETIC sample, with evidence; confirm / correct with the review kept after refresh and the text and raw model output unchanged — plus the unchanged-save fix and the request revision history with its history-gap notice. **Not covered** by this confirmation: any real model call or real-model extraction quality (not done), the number-boundary defect in the value-in-excerpt check and the missing overall API budget control (both still **blocking** any real call), search, translation check, zh-CN UI, access control. The 23 Oct acceptance stays passed.
- Item code decision: keep the stable Item reference; no SKU / SPU system; a supplier item code field is only a possible later helper (not approved, not scheduled); an equal code never replaces checking specification, material, capacity.
- **Still blocking any real AI call** (unchanged by the history work): the number-boundary defect in the value-in-excerpt check, and the missing overall API budget control (`docs/quote-extraction.md`). The real-model extraction is still **not done**. Neither item is marked passed.

### 25 Oct outcome

- **Done and tested (mock / fakes only):** number-aware value checks with rule version and new wording (excerpt found / value check / your review; older results labelled with the rules they were actually checked with, not used by the comparator); overall API budget (schema v9 ledger, per-attempt atomic reservation, settle / unknown / release, restart recovery, SGT day, integer micro-units, page display); search (all quote versions, origins and earlier values, ambiguity, safe input, access-scope entry point); supplement-context regression test; `npm run e2e:25oct`.
- **Not done (moved, not dropped):** comparator on stored extractions (→ 26 Oct first); quote rename log (no rename action exists — not needed for search; build only with a rename feature); supplier quote number entered in the composer at save time (design §2.3; → with 27 Oct term confirmation); `IT-` codes in search; real model (no provider approved).
- **Real-model acceptance stays not done.** MOCK results are not a substitute.
- Data: v8 → v9 on the real DB (backup, 21/21 checks); 4 MOCK runs added by the browser check on the `[TEST] e2e extraction` SYNTHETIC version (labelled MOCK, no budget rows).
- Cost: S$0 today, S$0 cumulative.

### 28 Oct night — review against requirements and fix

- **Gaps found in the first version (v11):**
  - replies stored as quote versions (latest quote, draft basis and comparator affected);
  - copied text without Q numbers (design deviation);
  - no source / unverified-sender label;
  - no unassigned replies or flag for conflicting buyer readings;
  - no basis per answer;
  - "Confirmed term" wording and no "updated quote needed".
- **Fixed in v12, minimal and data-preserving:** the v11 link and 4 answers carried over with their ids; the reply text was copied from its quote version, which stays as it is.
- **Still open:**
  - Quotes-page list of replies;
  - withdrawing a reply → quote link;
  - detecting that a linked updated quote was compared.
- **Access control:** owner decided the demo sign-in (design §6.4). Planned as v13, after the owner's go-ahead.
- **Unchanged:** the 29–30 Oct approval → payment priority, and the 31 Oct mid-point. No approval code was started.

### 28 Oct outcome

- **Built (assistant-tested, owner acceptance open):**
  - fixed question numbers Q1 … Qn on draft cards, plus the number each gets in the copied message (copy text unchanged);
  - a supplier reply saved as a later quote version or supplement, linked to the draft with the revision the user says was sent;
  - per-question answers with a verbatim excerpt from the reply;
  - user-confirmed terms with a deterministic values-in-excerpt look.
- **Schema v11** = reply tracking (next free number). **Access control therefore moves to v12.** No number was reserved.
- **Not started:** access control → **31 Oct morning** (as the confirmed shift allows). The approval → payment loop keeps 29–30 Oct and reads confirmed terms explicitly via `ReplyService.confirmedTerms()`.
- **Tests:** 340/340; browser 20/20 + 6/6 after restart. **Build not run today** (low free memory).
- **Calls today:** model 0, PayPal 0.

### 27 Oct outcome

- **Owner acceptance (27 Oct evening): five steps passed.** Owner-seen vs automated-only per row: `docs/design-24oct-additions.md` CL1–CL7 and setup-status "27 Oct 2026 (evening)". Idempotency after a basis change was checked: after a new draft, Create returns it again while the basis is unchanged (new independent test; the owner's drafts were not touched).
- **Usability backlog (with supplier reply tracking):** a stable, readable number on each question card. Needed for the per-question link of replies and for mapping copied (renumbered) questions back.
- **Built (assistant-tested; owner-accepted later the same day):**
  - bilingual clarification draft from the stored comparison: English + 简体中文 paired templates, question selection, English / 简体中文 / side-by-side views, edit, save with revisions and conflicts, copy with warnings;
  - deterministic per-question check: numbers, amounts, currencies, percentages, units, charging basis, dates, trade-term codes, quoted text;
  - basis-change notice with explicit regeneration;
  - details: `docs/clarification-drafts.md`.
- **Schema v10** (two append-only tables). Consistent backup, rehearsal on a copy (12 existing tables and 20 triggers unchanged), restore copy verified identical, applied to the local DB.
- **Access control moves to v11.** Rows 28 Oct and design §7 updated. No number was reserved in advance.
- **Not started:** supplier reply tracking. It moves to **28 Oct morning**, which the confirmed 26 Oct shift already allows. The impact on access control is unchanged from that note: about half a day on 28 Oct, leftovers 31 Oct morning. The approval → payment loop keeps 29–30 Oct.
- **Not built (needs the owner's go-ahead):** AI semantic translation check (A7 / A8 AI part) and full quote translation.
- **Calls today:** model 0, PayPal 0; ledger 5 rows / US$0.069710 unchanged.
- **Test data added (all [TEST] / SYNTHETIC):**
  - on the 26 Oct "browser check" record: 2 clarification drafts (one regenerated from the other) with 3 revisions, plus 1 CONFIRM review (currency) used to show the basis-change notice;
  - LA-1 … LA-5 untouched.

### 26 Oct outcome

- **Done and tested by the assistant:** comparator on stored extraction runs per requirements 1–7 (rows C1–C7). Computed on demand — no table, no migration, schema stays v9. Page `/procurements/:id/quotes/compare` (entry: "Compare with request →" on each quote version and on each comparable run in the extraction panel), GET API `…/versions/:versionId/comparison`. Details: `docs/quote-comparison.md` "Comparator on stored extractions (26 Oct)".
- **Evidence:** `tests/comparison.test.ts` 28/28 (pure tests on the five **stored** real-model runs as stored on 25 Oct + temp-DB service / HTTP tests with a counting test double); full suite 292/292 (one passing run — the budget thread test later turned out to be intermittent and was fixed the same day: `docs/setup-status.md` "26 Oct — budget test: database lock fix"; now 297/297); 11/11 mutations caught; lint, typecheck, build pass; headed Edge 20/20 (setup on a MOCK-mode server with labelled `[TEST] comparator` records) and 15/15 read-only on the normally configured server after a restart (LA-1, LA-3, LA-4, LA-5, older-rules run, updated request, test records).
- **Model calls: 0. Spend: 0.** (Computing a comparison writes nothing; the phase did add labelled test data, next bullet.) Budget ledger 5 rows / US$0.069710 before and after; LIVE runs 5 before and after; Sandbox payment record unchanged.
- **Data added (labelled test records only):** 2 `[TEST] comparator — … (26 Oct, SYNTHETIC)` requests with the SYNTHETIC zh demo quote and one labelled **MOCK** run each (canned output, no model, no budget); on the "browser check" record 2 reviews and 1 request revision (edit + reorder). LA records and earlier test records untouched. Backup before: `data/backups/sandbox-payments.sqlite.v9-before-comparator-test-data.2026-10-26.sqlite`.
- **Owner acceptance of C1–C7: open** (five-step check in `docs/setup-status.md`). → **Passed 26 Oct night** (owner's visual check of all five steps, incl. the results after steps 3–4).
- **Schedule impact:** the comparator used 26 Oct. The bilingual clarification draft + deterministic translation check move to **27 Oct (first)**; they now take their questions from the comparison (dependency). Supplier reply tracking / term confirmation follows on 27 Oct if time remains, otherwise 28 Oct morning, before access control. If that pushes access control (v10) into 29 Oct morning, the approval → Sandbox payment loop (29–30 Oct) keeps its priority and the 31 Oct mid-point stays. Proposed, not yet confirmed by the owner. Nothing is dropped.
- **Schedule confirmed by the owner (26 Oct, later):** the shift above is accepted, with the approval → payment loop kept at its priority. Synced in the schedule table: 27 Oct = bilingual clarification + deterministic translation check, then reply tracking if time remains; 28 Oct = reply-tracking overflow (morning) then access control. **Impact on 28 Oct:** if the morning goes to reply tracking, access control gets about half a day — v10 migration and enforcement on lists, detail / history, search, quotes, extraction / comparison (AI context) first, audit after; leftovers move to **31 Oct morning** (not 29 Oct), export checks come with the export (4 Nov), and A5 / A6 / A10 may be reported partial at the mid-point. Approval / payment starts 29 Oct morning regardless and uses `policy.ts`. Unchanged gates: no multi-user deployment (1–2 Nov) before access control is accepted; demo sign-in method (owner) needed before 28 Oct. Bilingual work waits for the owner's C1–C7 result.
- **Lesson:** after `npm run build`, clear `.next` before `npm run dev` — a stale build cache made every dev page reload in a loop (found and fixed during the browser check; not a code defect).
- **Evening — reliability work (owner-requested, outside the feature schedule):**
  - **Merged and in effect:** budget-test database lock fix (`4337435`: `busy_timeout` before `journal_mode`; failure located in connection setup, 27 / 70 runs before → 0 lock errors in 150 after).
  - **Fixed:** a reservation that cannot be written now finishes the run as `FAILED / BUDGET_UNAVAILABLE` (nothing sent, 503) instead of leaving it `RUNNING`; if the status itself cannot be written, the error is reported and the existing stale-run recovery applies.
  - **Open:** segmentation fault in the thread tests (≈ 2.7 % of runs, several thread tests in one process) — `docs/diagnostics/budget-threads-segfault.md`; not claimed stable.
  - **Page slowness:** not reproduced in a normal Edge window (warm pages 150–420 ms, first visit per route 0.6–2 s compile, 1.5–2.7× slower while tests run alongside); no code change; waiting for the owner's click sequence.
  - **Owner C1–C7 verdict: still open** at that time → **passed later that night** (owner). Bilingual clarification not started on 26 Oct; 27 Oct plan unchanged: bilingual clarification draft + deterministic translation check, then supplier reply tracking.
  - **Night:** owner reports no slowness in normal browsing → slowness **not reproduced, keep observing** (no root cause claimed). Segfault stays open. Collaboration rule added (below, "Rules later steps must keep").

### 25 Oct evening — acceptance feedback

- Owner: old-rules notice and "not configured" refusal **passed**; search step 1 open (7 candidates vs the checklist — the checklist number was stale, the assistant's error); step 2 counts passed, layout unclear.
- Added (small, today): **search categories, date sort, result counts and layout clarification** (`docs/setup-status.md` "25 Oct 2026 (evening)"). No advanced search, full-text index or extraction-page redesign.
- **Closed the same evening:** search five-step re-check **passed (owner)**; MOCK current-rules run (A) and switch back to the old run (B) **passed (owner)**; restart persistence **passed by automated checks only** (10/10 over HTTP + DB comparison), not an owner visual check. Real-model extraction **still not done**.
- **Moved to the late UI polish (5–6 Nov, with the EN / 简体中文 work), not scheduled earlier:** AI extraction readability — summary first (what was extracted, what needs review, next action), source evidence expandable, rule versions kept but de-emphasised; old-rules warnings, unknown values, candidate vs confirmed and MOCK labels must stay clear.
- Schedule impact: the comparator wiring starts after the 25 Oct re-acceptance on 26 Oct (half-day shift inside 26 Oct). Main line unchanged: real AI (needs owner decision), comparator, approval and payment loop.

### 25 Oct night — real model connected

- Anthropic `claude-sonnet-5-5` adapter built, budget reserves from real token counts; five SYNTHETIC real-model runs: US$0.069710 local estimate — `docs/live-model-acceptance.md`.
- **Owner-confirmed:** live connection and the five SYNTHETIC cases (five-step manual check + Anthropic usage comparison). **Automated checks:** repeat request (replay), restart persistence, tests 264/264, browser 8/8. **Mock / stub only:** concurrency, limits, timeouts, refusal, invalid output, unknown cost. **MOCK:** the 24–25 Oct runs. **Not done:** real quotes, comparator.
- Spend this phase: 5 real calls, US$0.069710 local estimate (owner compared it with the Anthropic usage page; still a local estimate, not the bill).
- Known limitations:
  - **Fee applies to which item is not linked:** a fee line has no item reference (LA-3 "for Item A only" is visible only in the excerpt).
  - **Conditions not yet agreed:** text such as "to be agreed after sample approval" is SUPPORTED as verbatim text but means "not agreed" (LA-5).
  - **Duplicate GOODS fee lines:** the model repeated the goods total as a fee line in three cases; counted as unknown in the cost overview, never added twice, but noisy for review.
  - **Sample size:** five small SYNTHETIC cases, one run each — no accuracy claim for real quotes.
- Schedule impact: none on the main line. The 26 Oct row starts with the owner's review of the real results, then the comparator on stored current-rules extractions; the AI translation check can now use the same approved provider and budget (no new spend authorisation needed within the US$5 / 100-call phase limit).

### Next phase: comparator (requirements agreed 25 Oct night; **built 26 Oct**, owner-accepted 26 Oct night)

Wire the deterministic comparator (`src/lib/quote-compare.ts`) to stored evidence. Requirements:

1. **Exact binding.** Every comparison records the quote version id (and its text hash), the request snapshot it was saved with (request id + revision), the extraction run id, and the value-check rules version of that run. Results from older rules are not used (as today: `toComparatorQuote` returns null).
2. **Stable item ids, never position.** Quote items are paired with request lines through the user's item-match decisions (`MATCH_ITEM` / `NO_MATCH`) on the snapshot's line ids; a proposed but unconfirmed match is shown as such; nothing is paired by order.
3. **User corrections are used, originals kept.** A user's `CORRECT` value feeds the comparison and is labelled as the user's statement; the model's original value, its excerpt and the check outcome stay visible and unchanged.
4. **Passing the value checks is not semantic correctness or agreement.** A SUPPORTED value means "source excerpt found"; the comparison never presents it as verified or as an agreed term.
5. **Open items stay open.** Unknown fee owner (which item a fee applies to), unknown currency, duplicate fee lines (e.g. a GOODS line repeating the total) and conditions not yet agreed are listed as **needs clarification** — no value is filled in and no definite total cost is produced.
6. **Unconfirmed results only raise questions.** They may produce discrepancies and clarification questions; they never become approved terms or a payment amount. Approval and payment (29–30 Oct) bind only explicitly confirmed terms.
7. **No new model calls for this.** Reuse the stored real results (LA-1 … LA-5), the MOCK fixtures and test doubles; the comparator itself is deterministic code.

Acceptance criteria (design §8, rows C1–C7): `docs/design-24oct-additions.md`.

### Resume order from 26 Oct (agreed scope)

1. ~~Owner acceptance of 25 Oct~~ — done 25 Oct evening (restart step by automated checks only).
2. ~~Comparator on persisted evidence (moved from 25 Oct), current-rules results only.~~ — built 26 Oct; owner-accepted 26 Oct night.
3. Clarification draft and the deterministic translation check — moved to 27 Oct (first), after the owner's C1–C7 check.
4. **Real model** only after the owner names provider, model, billing currency, prices and approved limits (`docs/quote-extraction.md` "Still needed for the first real call").

### Resume order from 25 Oct (agreed 24 Oct) — completed 25 Oct except step 3

1. **Fix the number-boundary defect** in the value-in-excerpt check (`contains()` in `src/server/extraction/check.ts`): number-aware matching with digit boundaries. Cases to test: `500` vs `1500 pcs` (must fail), `3.20` vs `13.20` / `3.205` (must fail), `3.2` vs `3.20`, thousands separators (`1,700.00` vs `1700.00`), units next to numbers (`500pcs`, `500 个`, `500ml`), Chinese full-width digits / punctuation, and a value occurring twice.
2. **Overall API budget control** across all records: a global counter and limit (runs and estimated cost per day and in total, inside the approved spend), checked inside the run transaction, safe under concurrent requests, and counting a timed-out call as "cost unknown — assume spent" (never as free).
3. **Real model**: only after the owner names provider, model and an approved spend limit — add the adapter, run the real-model acceptance (`docs/quote-extraction.md` "What a real model still needs"), record cost per run.
4. **Search** (design §3, A3 / A4): current requests and quotes, and supplier quote numbers in **every quote version, including earlier versions**; request revision contents are not searched.

While no provider is approved: keep doing 1, 2, 4 and other work that needs no model; never make a paid call.

The 25 Oct row below still lists the comparator wiring and the other search-related items. They follow after the four steps above, and whatever does not fit moves on and is reported.

## Rules later steps must keep

From 26 Oct (collaboration):

- **During the owner's manual acceptance, no stress / repeat test series and no builds** on this machine — they compete with the dev server and distort what the owner sees. Read-only checks are fine; heavy work waits until the owner says the check is done. Builds go in a separate worktree, never into the running dev server's `.next`.
- Owner visual checks and automated evidence are recorded separately; an automated-only check is never relabelled as owner-verified.

From 23 Oct:

- **Evidence boundary.** A version's request snapshot only says which request version the quote was *linked to when saved*. It is not evidence that the supplier received, accepted or promised to meet that request.
- **Latest ≠ accepted.** Approval binds explicitly confirmed terms of a specific version (and request revision), never "the latest text".
- **Supplements.** Extraction reads `contentKind`; for a supplement each term is *not mentioned* (keep the earlier version's term), *explicitly changed* or *contradicts*. Silence is never cancellation; nothing is merged automatically.
- **Extraction results** are stored per quote version id; **comparison results** per (quote version id, request snapshot / revision).
- Supplier display names are not identities and never select a PayPal payee. Saving a quote never confirms, approves or enables payment.

From 24 Oct (details in `docs/design-24oct-additions.md`):

- Buyer type (Business / Individual) is not the PayPal account type and never changes payment permission, protection eligibility or confirmation steps.
- Short references never replace full keys; an ambiguous short code returns candidates, never one picked at random.
- Supplier quote numbers are kept raw per version; AI only proposes candidates with an excerpt from the text; user-entered, AI-suggested and user-confirmed values stay distinguishable; no number is ever generated and shown as the supplier's.
- Quote text is data, never instructions; translations never overwrite originals; a check that was not run, failed or is stale is never shown as passed; no accuracy percentages.
- All reads (lists, search, detail, history, export, AI context, caches) go through one server-side access check from 28 Oct; masking is not access control; no multi-user isolation is claimed before it is accepted.
- Migrations are additive, backed up and transactional; immutable rows and their triggers are never rewritten or removed; derived data never changes evidence.

From 25 Oct:

- SUPPORTED means "source excerpt found"; a value check never claims semantic verification. Ambiguous numbers, currencies or units stay for the user. Results keep the value-check rules they were checked with; old results are never relabelled.
- Every LIVE attempt reserves its upper-bound cost atomically before sending; unknown outcomes stay counted; nothing resets the ledger; the budget limits only calls through this app.
- Search queries are bound parameters with no wildcards, bounded and limited, filtered by `requestScope` before LIMIT, and never call a model.

From 27 Oct (clarification drafts, `docs/clarification-drafts.md`):

- Questions are generated on the server from the stored comparison. The browser names a run only and never supplies amounts, quote text or findings. Only Difference / Needs-clarification items produce questions; none are invented to fill a draft.
- Every question keeps its id and source (row / fee, item line, values, runs, reviews); the draft keeps its basis (request revision, version + hash, run, reviews, comparator / template versions).
- Model values are worded "as we read your quote", never as agreed facts. Quoted text is kept as written and is never claimed as translated.
- A draft is labelled **Template-generated draft / Review before sending**. Copying marks nothing as sent, answered or confirmed. Unselected questions stay open.
- Draft rows and revisions are append-only. The generated text stays revision 1, unchanged saves write nothing and stale tabs get a conflict. A changed basis is reported and never re-bound silently. Regeneration is explicit and keeps the old draft.
- **The check result shows only for the exact text it checked.**
  - "No inconsistencies found within the supported rules" is never a sign-off and never green.
  - Edited wording and unreadable formats always need the user's review.
  - No "verified translation" and no percentages.

From 26 Oct (comparator, `docs/quote-comparison.md`):

- A comparison is computed from stored records only (text hash re-computed, snapshot revision, run, that run's reviews); the browser names ids. Opening, refreshing or comparing never starts an extraction or a model call.
- The basis is the snapshot saved with the version; a changed request is reported, never swapped in. Runs from older value rules, other versions or other requests are refused. A supplement uses only its explicitly linked base.
- Items pair by line ids (user decision first; a model proposal is labelled); never by position. Reviews apply only to their own run and field.
- "Consistent" is not "confirmed"; unparsed or "to be agreed" wording stays open. Unknown amounts / currencies / fee scope are open, GOODS repeats are not added, nothing is a total cost or a payment amount.
- Only user-confirmed or user-corrected matching rows on user-chosen pairings (`userConfirmedMatches`) may feed approval (29–30 Oct).

From 24 Oct (extraction, `docs/quote-extraction.md`):

- The server reads everything sent to a model from stored records. Clients send only a run key.
- A value counts only when its excerpt is found in that version's text (`SUPPORTED`). User confirmation is a separate, append-only record. Model output, text support and user confirmation are never shown as the same thing.
- Amounts, sums and cost overviews come from code. No extraction result sets a payment amount or payee. Unknown is never 0.
- No real paid call without an approved provider, model and spend limit. MOCK is always labelled. Timeouts are not retried. Re-runs need explicit consent.
- A save that changes nothing writes nothing (no revision, no `updated_at`, no history). Every real change of a request is stored as an immutable revision snapshot in the same transaction. History that was never stored is shown as unavailable, never reconstructed.

## Planned features (accepted scope; design only)

| Feature | What | When |
| --- | --- | --- |
| Fee fields in extraction | Each cost line: amount, currency, payer, payee, included-in-quote yes/no, source text, status (confirmed / estimated / to confirm / not applicable) | 24 Oct (AI extraction) |
| Trade-sheet preview & fee breakdown | Goods, freight, insurance, applicable taxes and duties (incl. possible export-side charges), customs services, payment and other fees; separates **this PayPal payment**, the **buyer's known total cost** and **unknown costs**; no double counting | 29–30 Oct |
| A–D transaction-readiness grade | Explainable rules over current evidence. No grade when evidence is insufficient; a blocking item cannot be offset by passes. Not a PayPal score, no PayPal private data, not a fraud probability or safety guarantee | 29–30 Oct |
| **AI Copilot (first version)** (added 30 Oct) | Side panel in one record: explains differences, blocked approval, unresolved replies, this payment's amount; cites versions / revisions / runs / excerpts; facts from deterministic code; no actions; untrusted quote text; same budget; no call on refresh; EN first (product brief §4a; matrix CP1–CP12) | **Planned, not built** — 3–4 Nov, after access control |
| Quote-file import (one common format) (added 30 Oct) | Reduce typing: import once, reuse everywhere. Format not chosen | **Evaluate only**; mailbox import later; not scheduled for build |
| Issue-handling summary | Terms, versions, communication timeline, verified payment status, user statements, evidence present / missing → editable bilingual draft | 4 Nov |
| Feedback for later improvement | AI output, cited evidence, user corrections, model / prompt / rule versions. Evaluation only; no automatic training; business data storage separate from training consent; AI output never its own ground truth | 24 Oct onward (records); 5–6 Nov (checked with test users) |
| Buyer type, references, search, languages, translation check, access control | `docs/design-24oct-additions.md` | 24–28 Oct build, 31 Oct / 6 Nov acceptance (table above) |
| Readable question numbers on draft cards (usability backlog, 27 Oct) | A stable, readable number on each clarification question card (not the copy's renumbering); shown again where replies are linked per question | With supplier reply tracking (next phase) |
| Supplier item code (optional helper field) | Possible later aid next to the Item reference; never a substitute for checking specification, material, capacity | **Not approved, not scheduled** (24 Oct discussion) |

## Later extensions (not scheduled; do not block the main flow)

Automatic training / fine-tuning, global tax and duty calculation, global customs procedures, autonomous payment, supplier portal (needs authenticated identity binding, `docs/design-24oct-additions.md` §6.1), screen-privacy mode (§6.3), languages beyond EN / 简体中文 (§4), AG Studio.

Candidate directions (evaluate, not scheduled): risk prevention, early warnings, after-sales handling (`docs/product-brief.md` §9). No refund or dispute system is planned.

## Acceptance still open from the original phases

- Webhook `PAYMENT.CAPTURE.COMPLETED` verified and attached (planned 1–2 Nov; now 5 Nov only with a public URL; **not done**).
- Payment button only for an approved record; amount from the locked approval (29–30 Oct) — **30 Oct: built, MOCK-verified, and one real Sandbox run (AP12, USD 12.00) PAID and verified.**
- End-to-end run with synthetic data in under 3 minutes (31 Oct).
- Fresh clone → setup → full flow following README only; video, repo URL and description submitted (8–11 Nov).
