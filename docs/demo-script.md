# Demo regression script — full MOCK flow, 20 steps (3 Nov 2026; labels re-checked against the 5 Nov Quotes page on 6 Nov)

**What this is:** the complete flow on ONE continuous SYNTHETIC record on a **database copy**, with **MOCK extraction,
MOCK Copilot and MOCK PayPal**. It is the regression script (every step by hand) and the way to prepare the record for
the 3-minute demo (`docs/demo-3min.md`). It is **not** a real AI → real PayPal chain. The real Sandbox payments of
30 Oct (USD 1.00, USD 12.00) are separate historical evidence on the main database and are not repeated here.

**Server (MOCK database only) — simplest (3 Nov):** `npm run mock:start` (PowerShell `npm.cmd run mock:start`), optionally with `TRADEPROOF_MOCK_DB=<file>`; it checks the mode, refuses the main database and clears `.next` when the database changes (`docs/run-guide.md` §3). **Equivalent manual start:** stop any server, clear this project's `.next`, then from Git Bash:
`env -u ANTHROPIC_API_KEY -u TRADEPROOF_COPILOT_LIVE AI_PROVIDER=mock AI_API_KEY=" " AI_MODEL=" " TRADEPROOF_APPROVAL_PAYMENTS=mock TRADEPROOF_DB_PATH=<copy> npx next dev -H 127.0.0.1`.
The server refuses MOCK payments on the main database. Two accounts in the copy: one buyer, one approver.

**Demo data (SYNTHETIC; MOCK outputs hand-written):** `purchase-request.synthetic.json` (500 pcs, ≈ USD 1,700, 30 %
deposit — stays a blocked case: staged payment, CNY quote, above the USD 100.00 Sandbox ceiling), `supplier-quote-zh`
(v1, blocked), `supplier-quote-revised` (v2: the **sample order** the request is revised to — 20 pcs, 304, 500 ml matte
black, laser 1 colour, USD 3.40 → USD 68.00, 100 % before shipment). Request and quote agree on quantity, specification
and purpose; the amount is small because the buyer orders a 20-piece sample, not because a figure was shrunk.

## Steps (buyer unless marked)

| # | Page | Action | What to point at |
| --- | --- | --- | --- |
| 1 | Procurement requests → **+ New request** | **Load demo (SYNTHETIC)** → **Save draft** | revision 1; Access panel: no approver |
| 2 | Request → **Add a quote** | **Load demo: Chinese quotation 中文报价单** → **Preview** → **Save version 1** | "saving does not accept or approve" |
| 3 | Quotes (v1) | Copilot **Where do I go next?** | MOCK label; facts "not AI"; next step = run + review |
| 4 | Quotes (v1) | **Run extraction (MOCK)** → **Confirm** each value and **Save match** for the item (25 targets = 24 values + 1 match; **Next to review** jumps to the next open one; read each source line) | "MOCK — not an AI result"; "Reviewed 25 of 25 … ✓ All reviewed" |
| 5 | **Compare with request →** | read | 5 differences; fees "unknown, not 0"; no total cost |
| 6 | Compare → **Create clarification draft** | read EN / 中文 | template, not AI, nothing sent |
| 7 | Draft → **Paste a supplier reply** | paste the reply below, tick **Link it to this draft** → **Save supplier reply** | kept on its own, not a quote version |
| 8 | Draft → Q1 **Record answer** | "answers it", excerpt `[Q1] 数量可以做到 500 个。`; Q2 "answers it partly", excerpt `[Q2] 可以改用 304 不锈钢，单价调整为人民币 26.80 元/个，新报价单随后发送。` | Q1 Answered, Q2 Open — partly; "Deal: not approved" |
| 9 | Quotes (v1) | Copilot **What is still open after the supplier's reply?** | open list; notice "answered … does not approve any term" |
| 10 | Quotes (v1) | Copilot **Why can't this be approved?** | every blocker with its basis (two budget reasons, each named) |
| 11 | Request → **Edit** | quantity **20**; budget cap **100.00**; payment terms **100% advance payment before shipment**; additional requirements **`SYNTHETIC / DEMO DATA — fictional. Sample order: 20 pcs to check quality before a main order of 500 pcs. Incoterm: FOB Ningbo; ship by 2026-12-10. Maximum unit price: USD 3.60 / pcs.`** → **Save draft** | revision 2 = the sample order (purpose stated) |
| 12 | Quotes → **+ Add revision** | **Load demo: Revised sample-order quote 修订报价（样品单） · SYNTHETIC, MOCK demo** → **Preview** → **Save as version 2** | v2 linked to request revision 2 |
| 13 | Quotes (v2) | **Run extraction (MOCK)** → **Confirm** each value and **Save match** (the bar shows the exact count; **Next to review**) | 20 · 304 · 500 毫升，哑光黑 · 激光雕刻 1 色 · USD 68.00 · 100 % 定金（预付） |
| 14 | Quotes (v2), decision summary at the top → **Full approval preview** | item notes: **Not a key condition**, reason "Label marking the item as fictional demo data; not an order condition."; additional requirements: **Key condition — the quote states it**, excerpt `20 个（样品单）`, reason "Sample order of 20 pcs — the quote states 样品单; FOB and ship date are checked by the rules; unit price USD 3.40 is within USD 3.60." | BLOCKED → READY WITH CONFIRMATIONS; USD 68.00; the approver's confirmation shown read-only |
| 15 | Quotes (v2) | Copilot **How much is this payment…?** | "Proposed amount for a MOCK payment … not payable now and not a payment authorisation" |
| 16 | Request → Access | **Assign as approver** | history line; Quotes v2 summary "Next step for you: Waiting for Approver to approve (they confirm 1 item)" |
| 17 | *Approver* → request → **Open quotes** → v2 summary **Review and approve** (button) | Copilot **Where do I go next?** ("You can review and approve …"); tick the confirmation → **Approve these conditions** | Approve disabled until ticked; "Approved — Active … USD 68.00" |
| 18 | *Buyer* → Quotes (v2) | read the decision summary | cells "Approval ✓ Approved — Active", "Payment ○ Not paid"; "Approved payment USD 68.00."; next step "Approved. You can pay now, on the approval page." + **Go to payment**; on v1: "Not approved — the Active approval is for version 2" |
| 19 | **Go to payment** → approval page | **Start payment (create the payment record)** → **Create PayPal order** → **Simulate buyer approval (MOCK)** → **Capture payment** | "PAID (MOCK) … No PayPal request"; TP-APPROVAL-MOCK; back on Quotes v2: "Payment ✓ Paid (MOCK)", rule check "New approval blocked — this version has already been paid." (not a failure) + **View payment** |
| 20 | optional | Copilot payment question / next step; re-confirm one value, **Check now**, open the approval page | "MOCK payment … not a Sandbox payment"; old answer "Based on an earlier state"; approval "No longer valid"; payment stays PAID |

SYNTHETIC supplier reply (step 7): `SYNTHETIC / DEMO reply (fictional). [Q1] 数量可以做到 500 个。[Q2] 可以改用 304 不锈钢，单价调整为人民币 26.80 元/个，新报价单随后发送。`

## Still manual / known limits

- One click per reviewed value (≈ 24 + 18); reply and excerpts are pasted by hand. No bulk confirm (by design).
- MOCK extraction reads only the three built-in demo quotes; any other text fails honestly (MOCK_NO_FIXTURE).
- A reviewed value keeps its decision; changing it needs **Review again** (5 Nov) and stores a new entry, which makes an Active approval of that version no longer valid (fail-safe).
- The request page gives the approver no direct approval-page link (Quotes → decision summary **Review and approve** works; deferred).
- For a *check* only, `scripts/seed-demo-walkthrough.mts` prepares steps 1–16 on a copy through the services (operator-written reviews — not a person's review; not for a recorded demo).
