# TradeProof — Product Brief

> 面向小企业的跨境采购 AI 助手 · A cross-border procurement AI assistant for small businesses
> Updated **30 Oct 2026** (mentor feedback: narrower first customer, less typing, value validation, AI Copilot — §1a, §4a, §8a, §11; these are plans and hypotheses, not results). Earlier update 24 Oct 2026. Implemented parts are marked **(built)**; everything else is planned. Schedule: `docs/implementation-plan.md`. Design of the 24 Oct additions (buyer type, references, search, languages, translation check, access control): `docs/design-24oct-additions.md`.

## 1. Goal

Help a small business buying from overseas (mainly Chinese) suppliers carry one purchase through **request → quote → clarification → approval → payment → records**, with an AI assistant that checks the purchase, helps ask the right questions and says what to do next — and demonstrate it end-to-end with PayPal Sandbox for the PayPal AI Hackathon (submission deadline **12 Nov 2026, 12:00 pm PT**).

## 1a. First-version target customer (30 Oct 2026 — a hypothesis to test, not market research)

**Hypothesis.** The first version is aimed at:

> a **small-business buyer** who buys **samples, customised goods or small batches** from a **small overseas supplier that accepts PayPal**, and who needs to check the quote, clarify the conditions and **bind the approved conditions to the payment**.

- This is a **customer hypothesis waiting to be validated** (§11). No market research, interviews or measurements have been done yet; nothing here is a finding.
- The **individual-buyer** features stay (buyer type *Individual*, §2). Nothing is removed and no existing data is migrated or deleted because of this focus.
- **Not claimed:** suitability for every factory, for large orders, for instalment / staged payments, or for bank transfers (T/T). v1 pays one full stated USD total in one PayPal payment (`docs/approval-design.md` §4.2); deposits are blocked.

**Demo boundaries (say these wherever the demo is shown):**
- the payee is **one fixed PayPal Sandbox test merchant** from the server configuration;
- this does **not** mean TradeProof can pay an arbitrary supplier's account;
- it is **not escrow** and not a hosted / held-funds payment ("托管支付"); TradeProof never holds money;
- TradeProof has **no access to PayPal's private transaction data**; it sees only its own orders and captures through the Orders API.

## 2. Users

| User | Situation | What they need |
| --- | --- | --- |
| **Buyer / procurement owner** at a small SG or international brand, studio or e-commerce shop (main demo scenario) | Receives quotes in Chinese, English or both; quotes often disagree with the request or with each other | Understand the quote, spot differences, know what to ask and what is still unknown |
| **Individual buyer** (supported, buyer type *Individual*) | Same flow for a personal cross-border purchase; may add a company / organization | Same as above. Buyer type is not the PayPal account type and changes no payment rule or confirmation step |
| **Approver** (owner, finance lead) | Must sign off before money moves, often not in the supplier chat | One screen with the confirmed terms, evidence, differences, costs and the exact amount |
| **Supplier** (indirect user) | Prefers Chinese; receives clarification messages and payment | Clear bilingual questions; a payment it can recognise |

## 3. Core flow

1. **Purchase request 采购需求** **(built)** — items (each with a stable id), spec, quantity, budget, ship date, accepted payment terms; revision-checked edits.
2. **Quote import & versions 报价导入与版本** **(built, pasted text)** — each supplier quote is a series of immutable versions: exact text, hash, source, content kind (full quote / supplement), user's revision note, and a snapshot of the request it was linked to when saved.
3. **Quote understanding 报价理解** — AI extracts structured fields (incl. cost lines) from a specific version; every field keeps its verbatim source text (schema and source check **built**; AI step planned 24 Oct).
4. **Discrepancy check 差异检查** — deterministic comparison of spec, quantity, amount, currency, Incoterm, lead time and payment terms against the request snapshot and between language versions (comparator **built** on synthetic data; wiring to stored versions 25 Oct).
5. **Clarify 沟通确认** — bilingual draft; a human edits and sends it (no auto-send). Supplier replies are saved as new versions or supplements, and the user marks which terms are confirmed.
6. **Human approval 人工审批** — the approver approves explicitly confirmed terms of a named quote version and request revision; approval is an internal decision, separate from PayPal payer authorisation.
7. **PayPal Sandbox payment** — server creates the order for the exact approved amount, buyer approves, server captures and verifies (payment path **built** and verified with USD 1.00 on 21 Oct). **30 Oct:** linked to the approval — amount, currency and payee only from the stored approval, validity re-checked at record / order / capture, payment panel on the approval page; verified with MOCK PayPal, and **one real Sandbox payment of an approval (USD 12.00) PAID and verified on 30 Oct** (owner-authorised; its quote extraction was a MOCK replay, so this is not yet a real AI → payment run).
8. **Records 资料整理** — request revisions, quote versions, findings, messages, approval, payment ids, checklist and export.

## 4. The assistant (layout and data needs — design only, 23 Oct)

Three actions, always grounded in stored records, never in invented state:

| Action | Shows | Needs from the data model |
| --- | --- | --- |
| **Check this purchase 检查采购** | Findings for (quote version, request revision) with source text on both sides; what is unknown | Extraction results keyed by quote version id; comparison results keyed by (version id, request revision); item ids to match lines |
| **Help me ask 帮我问清楚** | Editable bilingual questions for open findings | Findings with status (open / asked / answered), message drafts, which version a reply came in |
| **Tell me the next step 告诉我下一步** | The real current state and the one next action (e.g. "v3 is a supplement; payment terms still unconfirmed") | Request revision, latest saved vs confirmed terms, approval state, verified payment state |

Layout plan: a side panel on the request and quotes pages (collapsible on narrow screens) with the three actions as buttons; every statement links to the record or the source line it came from; it shows "not available yet" instead of guessing. No chat surface and no model output is faked before the AI step exists.

## 4a. AI Copilot — first version (30 Oct 2026: **planned, not built, not accepted**)

Formally added to the plan on 30 Oct. It refines §4 into one assistant panel; until it is built and accepted it is **not an existing feature** and must not be shown or described as one.

**Form.** A side panel inside **one procurement record** (the record the user has open). No general chat across records.

**What it does (v1):**
1. explain differences between the quote and the request, and the open clarification items;
2. explain **why an approval is blocked** (from the approval gate's findings);
3. summarise supplier replies and what is **still unresolved**;
4. explain **this payment's amount** and the fees that are unknown / excluded / not in this payment;
5. point to the existing page and the next step (link, not an action).

**Boundaries (each is an acceptance requirement, matrix CP1–CP12 in `docs/design-24oct-additions.md` §8):**
- The **server** gathers the record's data, only for a user who may access it (`canReadRequest`; after sign-in, the object-level rules). The browser sends a record id and a question, nothing else.
- Every answer **cites** the concrete quote version, request revision, extraction run or source excerpt it relies on.
- **Business states, amounts and approval eligibility come from the existing deterministic code** (comparison, approval gate, payment records). The model may explain them; it never computes or overrides them.
- **Missing or outdated basis is said plainly** (e.g. "no reviewed run", "approval no longer valid", "basis changed since …").
- It **cannot** change conditions, confirm terms, approve, pay, or work around a block. It has no write tool.
- Quote and reply text are **untrusted data**: instructions inside them are not followed.
- **No other buyer's records** reach the model or the answer.
- It uses the **same API budget, call ledger and spend controls** as extraction (v9 ledger; a new purpose, not a new budget).
- **Refreshing or opening the page never starts a model call**; a call happens only when the user asks.
- **English first**, 简体中文 as a secondary language.

**Order (owner, 30 Oct):** approval → Sandbox loop → sign-in and object-level access → **minimal Copilot** → presentation polish. The Copilot depends on access control (it must read only permitted records). The **A–D readiness grade stays a separate, deferred item**; neither the Copilot nor the approval gate is a readiness grade.

## 5. Responsibility split

| Layer | Does | Never does |
| --- | --- | --- |
| AI (runtime model) | Extract, translate, explain, draft messages, suggest questions | Approve, change amounts, decide payee, trigger payment, treat its own output as verified |
| Human | Save and label quotes, confirm extractions and terms, send messages, approve / reject | — |
| Deterministic code | Store versions immutably, compare fields, compute totals, validate amount / currency / payee before and after payment, enforce idempotency | Guess or "fix" data silently |

## 6. Evidence boundaries (apply to every screen and AI output)

- A quote version's request snapshot shows the request it was **linked to when saved** — not that the supplier received, accepted or promised to meet it.
- **Latest saved ≠ accepted.** Approval binds explicitly confirmed terms of a specific version.
- A **supplement** never replaces a full quote; terms it does not mention are not cancelled. Extraction distinguishes *not mentioned*, *explicitly changed* and *contradicting*.
- The text hash detects later changes to stored text; it does not prove authorship or authenticity.
- Supplier display names are not verified identities and never choose a PayPal payee.
- Data source labels (user input / demo / test) are recorded explicitly, never guessed from titles or text.
- Supplier quote numbers are kept as written, per version. AI may only suggest one with an excerpt from the text; user-entered, AI-suggested and user-confirmed values are labelled differently; an absent number stays empty. The TradeProof reference (`QS-…`) is never shown as the supplier's number.
- A translation never replaces the original. "No critical differences detected" is not a guarantee of accuracy; checks not run, failed or out of date are never shown as passed. Only pasted, saved text is checked — not original PDFs, images, file integrity or supplier identity.
- Quote text is data to analyse, never instructions to the system.
- Ids, short references and quote numbers are not credentials. Access is decided on the server per record; masking text is not access control.

## 7. Planned features (recorded 23 Oct; scheduled in the plan)

- **Trade-sheet preview and fee breakdown** — goods, freight, insurance, applicable taxes and duties (including possible export-side charges), customs services, payment and other fees. Each line: amount, currency, who pays, who is paid, included in the quote or not, source, and status *confirmed / estimated / to confirm / not applicable*. Separates **this PayPal payment**, the **buyer's known total cost** and **unknown costs**; avoids double counting.
- **A–D transaction-readiness grade** — explainable, rule-based, from current evidence: consistency of terms, clarity of costs, fulfilment agreements, payment readiness. No grade when evidence is insufficient; a blocking item cannot be offset by other passes. Not a PayPal score, no PayPal private data, not a fraud probability or a guarantee of safety.
- **Issue-handling summary** — terms, versions, communication timeline, verified payment status, user statements, evidence present and missing → editable bilingual draft.
- **Feedback for improvement** — record AI outputs, cited evidence, user corrections and model / prompt / rule versions; used for evaluation during the hackathon, no automatic training; storage of business data is separate from any training consent; AI output is never its own label.
- Reference exchange rates and cost overview; scenario document checklist, payment proof and basic export.
- **Buyer type** Business / Individual; clear **Request ID**, **Item reference**, **TradeProof quote reference**, **Quote name**, **Supplier quote number** and **Version**; **search** on the request list by any of them (history included, ambiguities listed, never merged).
- **Languages**: UI in English by default, English / 简体中文 first; quotes keep *Original language* and *Translate into* apart; original / translation / side-by-side views; deterministic + AI translation check (Chinese ↔ English first). Other languages are candidates, opened only after testing.
- **Access control**: buyer owner and explicitly authorised members by role; other buyers see nothing; one server-side check for lists, search, detail, history, export and AI context; audit of access decisions. Optional screen-privacy mode later, never a substitute.

## 8. First version scope (hackathon MVP)

- Buyer workspaces with owner and member roles and object-level access control (28 Oct); one Sandbox test supplier account; approver may be the same person in the demo. No supplier login.
- Pasted quote text (Chinese / English). PDF, images, OCR, email fetching and URL fetching are out of scope for now.
- UI in English and 简体中文.
- Uses only synthetic / demo / explicitly marked test data. Sandbox only, no real money.

## 8a. Less typing (30 Oct 2026 — direction; nothing new built)

- **Today:** the buyer pastes the quote text (built).
- **Product goal:** import once; the quote, comparison, clarification, replies, approval and payment then reuse the stored data instead of asking for it again. (Much of this reuse already exists: comparison, drafts, replies and approval read stored versions and runs.)
- **To evaluate (not chosen, not built):** import of **one common quote-file format**. Which format is open; evaluation only.
- **Later direction:** forwarding e-mail / mailbox import.
- **Not developed now:** file parsing, mailbox integration, supplier portal.

## 9. Non-goals and candidates

Non-goals: escrow or holding funds; paying arbitrary third-party suppliers in production; live PayPal or real money; auto-sending messages, auto-approving or autonomous payment; KYC, compliance certification, customs filing; ERP integration and enterprise SSO; refund or dispute systems; supplier portal; consumer shopping platform.

Optional extensions (do not block the main flow): complete automatic tax / duty calculation, global customs procedures, AG Studio, automatic training / fine-tuning, supplier portal (needs authenticated identity binding), screen-privacy mode, further UI languages.

Candidate directions to evaluate (not scheduled): risk prevention and early warnings, after-sales handling.

## 10. Success criteria for the demo

- A judge can clone the repo, set Sandbox credentials, run it, and complete the flow with the synthetic samples.
- The demo surfaces the six seeded discrepancies in `samples/synthetic/expected-discrepancies.synthetic.json` from a stored quote version.
- The payment record shows the PayPal order ID, capture ID, captured amount and currency matching the approved values.

## 11. Value validation (30 Oct 2026 — planned; **nothing measured yet**)

**Exploratory buyer interviews (to be held; none done).** Questions:
- which misunderstandings of quotes or conditions they actually had;
- what those cost: extra fees, delays, extra rounds of messages, time spent checking;
- which payment methods their suppliers actually accept;
- whether they would import their next quote into TradeProof.

**SYNTHETIC worked example (explains a missed cost only):**
- Understood at first: 200 pcs × USD 4.00 = **USD 800.00**.
- Also in the quote: freight **USD 120.00** and packing USD 0.30 × 200 = **USD 60.00**.
- Difference: **USD 180.00**, i.e. **22.5 %** more than first understood (USD 980.00 in total).
- This is a **fictional illustration** of how a missed fee line changes the amount. It is **not** an average loss, a measured saving or a market statistic. (Arithmetic checked in code, 30 Oct, integer cents.)

**User-test metrics for later tests** (each stays **"not measured"** until a real test produces data; no number is invented):

| Metric | Definition | Status |
| --- | --- | --- |
| Checking time | Time from pasting a quote to a decision (approve / ask / reject) | not measured |
| Omissions found | Missing or differing conditions / fees the buyer found with TradeProof | not measured |
| False alarms | Findings the buyer judged wrong or irrelevant | not measured |
| Completion rate | Share of test buyers who complete request → quote → approval (→ Sandbox payment) | not measured |
