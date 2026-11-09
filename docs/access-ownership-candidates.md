# Access control — records waiting for an owner (read-only list, 29 Oct 2026)

> **Nothing here is executed.** The access-control migration has not been written; no account or permission exists.
> Listed read-only from the local DB at schema v13 on 29 Oct (≈ 00:50 SGT). Titles truncated to 60 characters; no quote text, prices or other content.

## Proposed scheme (owner's recommendation, 28 Oct night — to confirm before the migration is written)

1. **New dedicated demo data** for Buyer A and Buyer B, created through the app after sign-in exists, for the isolation acceptance. The existing records are not used for it.
2. **Existing records are assigned only after the owner chooses**, record by record or by group (e.g. "all `[SYNTHETIC / LIVE TEST]` LA-1…LA-5 → Buyer A"). Nothing is assigned automatically; earlier wording that proposed "all → Buyer A" is withdrawn.
3. **Unassigned existing records are not accessible to the ordinary demo accounts.** They stay in the database unchanged and are reachable only through the local developer mode until assigned.
4. **The approver sees only procurements explicitly assigned to them**, through an append-only grant; never all procurements by default.
5. No public registration, password reset or supplier portal (owner decision, 28 Oct).

## Records (32)

"Marked" = what the title / source says (`TEST`, `SYNTHETIC`, upper-case `DEMO`, `demo-source` = filled by *Load demo*). Every record is marked; none looks like real business data. Counts are of related rows: quote series / versions, extraction runs (LIVE in brackets), clarification drafts, supplier replies / answers.

| # | Request | Title (truncated) | Marked | Created (UTC) | Quotes / versions | Runs (LIVE) | Drafts | Replies / answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PR-79ED0A13 | [SYNTHETIC / DEMO] PR-DEMO-0001 — Stainless steel insulated  | SYNTHETIC+DEMO+demo-source | 2026-10-22T08:33 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 2 | PR-312FCBCE | [SYNTHETIC / DEMO] PR-DEMO-0001 — Stainless steel insulated  | SYNTHETIC+DEMO | 2026-10-22T08:53 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 3 | PR-93BD8D54 | [TEST] Edit-conflict repro 2026-10-22 (not demo data) | TEST | 2026-10-22T08:59 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 4 | PR-AB61FC1A | [TEST] e2e edit conflict 2026-10-22T09:03:24.540Z | TEST | 2026-10-22T09:03 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 5 | PR-D639B4A0 | [TEST] e2e edit conflict 2026-10-22T09:03:39.512Z | TEST | 2026-10-22T09:03 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 6 | PR-D735C76D | [TEST] Load-demo source check — renamed again | TEST+demo-source | 2026-10-22T09:22 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 7 | PR-26BFB82D | [TEST] Ordinary request with DEMO and demo in the title | TEST+DEMO | 2026-10-22T09:22 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 8 | PR-0132FCA8 | [TEST] e2e edit conflict 2026-10-22T09:23:06.338Z | TEST | 2026-10-22T09:23 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 9 | PR-45F46FEB | [TEST] e2e quotes 2026-10-23T12:07:25.549Z | TEST | 2026-10-23T12:07 | 1 / 5 | 0 (0) | 0 | 0 / 0 |
| 10 | PR-BB5BE897 | [TEST] e2e edit conflict 2026-10-23T12:08:07.786Z | TEST | 2026-10-23T12:08 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 11 | PR-66EB38E2 | [TEST] e2e quotes 2026-10-23T12:11:50.690Z | TEST | 2026-10-23T12:11 | 1 / 5 | 0 (0) | 0 | 0 / 0 |
| 12 | PR-3170575B | [test] | TEST+demo-source | 2026-10-23T15:29 | 2 / 3 | 0 (0) | 0 | 0 / 0 |
| 13 | PR-477C58C4 | [TEST] e2e extraction 2026-10-24T08:06:49.054Z | TEST | 2026-10-24T08:06 | 1 / 1 | 0 (0) | 0 | 0 / 0 |
| 14 | PR-8B88F1B2 | [TEST] e2e extraction 2026-10-24T08:07:45.759Z | TEST | 2026-10-24T08:07 | 1 / 2 | 7 (0) | 0 | 0 / 0 |
| 15 | PR-55222395 | [TEST] e2e edit conflict 2026-10-24T08:09:01.622Z | TEST | 2026-10-24T08:09 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 16 | PR-6866FFE5 | [TEST] e2e quotes 2026-10-24T08:09:08.563Z | TEST | 2026-10-24T08:09 | 1 / 5 | 0 (0) | 0 | 0 / 0 |
| 17 | PR-5E7759F6 | [TEST] e2e quotes 2026-10-24T08:09:36.959Z | TEST | 2026-10-24T08:09 | 1 / 5 | 2 (0) | 0 | 0 / 0 |
| 18 | PR-A0B4A6EC | [TEST] e2e history 2026-10-24T10:25:10.918Z | TEST | 2026-10-24T10:25 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 19 | PR-FFDC235D | [TEST] e2e edit conflict 2026-10-24T10:25:56.512Z | TEST | 2026-10-24T10:25 | 0 / 0 | 0 (0) | 0 | 0 / 0 |
| 20 | PR-93BA6713 | [TEST] e2e quotes 2026-10-24T10:26:03.712Z | TEST | 2026-10-24T10:26 | 1 / 5 | 0 (0) | 0 | 0 / 0 |
| 21 | PR-99154D49 | [SYNTHETIC / LIVE TEST] LA-1 normal complete quote | SYNTHETIC | 2026-10-25T11:33 | 1 / 1 | 1 (1) | 0 | 0 / 0 |
| 22 | PR-62D0AE5A | [SYNTHETIC / LIVE TEST] LA-2 number confusion | SYNTHETIC | 2026-10-25T11:48 | 1 / 1 | 1 (1) | 0 | 0 / 0 |
| 23 | PR-9A79283A | [SYNTHETIC / LIVE TEST] LA-3 multi-item cross references | SYNTHETIC | 2026-10-25T11:48 | 1 / 1 | 1 (1) | 0 | 0 / 0 |
| 24 | PR-E1948C0C | [SYNTHETIC / LIVE TEST] LA-4 supplement linked to v1 | SYNTHETIC | 2026-10-25T11:48 | 1 / 3 | 1 (1) | 0 | 0 / 0 |
| 25 | PR-17C9F0C5 | [SYNTHETIC / LIVE TEST] LA-5 missing or vague fees and terms | SYNTHETIC | 2026-10-25T11:48 | 1 / 1 | 1 (1) | 0 | 0 / 0 |
| 26 | PR-0FA23DEB | [TEST] comparator — browser check (26 Oct, SYNTHETIC) | TEST+SYNTHETIC | 2026-10-26T05:12 | 1 / 2 | 1 (0) | 2 | 3 / 6 |
| 27 | PR-302DD831 | [TEST] comparator — manual acceptance (26 Oct, SYNTHETIC) | TEST+SYNTHETIC | 2026-10-26T05:12 | 1 / 1 | 1 (0) | 2 | 0 / 0 |
| 28 | PR-950AE5A1 | [TEST] e2e replies 2026-10-28T15:46:21.296Z (SYNTHETIC) | TEST+SYNTHETIC | 2026-10-28T15:46 | 1 / 2 | 1 (0) | 1 | 3 / 5 |
| 29 | PR-81DBDEE0 | [TEST] e2e replies 2026-10-28T15:46:42.388Z (SYNTHETIC) | TEST+SYNTHETIC | 2026-10-28T15:46 | 1 / 2 | 1 (0) | 1 | 3 / 5 |
| 30 | PR-1D2AD6C0 | [TEST] e2e replies 2026-10-28T15:47:27.166Z (SYNTHETIC) | TEST+SYNTHETIC | 2026-10-28T15:47 | 1 / 2 | 1 (0) | 1 | 3 / 5 |
| 31 | PR-32F92D1A | [TEST] e2e replies 2026-10-28T15:49:01.902Z (SYNTHETIC) | TEST+SYNTHETIC | 2026-10-28T15:49 | 1 / 2 | 1 (0) | 1 | 3 / 5 |
| 32 | PR-6117B2A1 | [TEST] reply acceptance (owner, 29 Oct) 2026-10-28T15:49:58. | TEST+SYNTHETIC | 2026-10-28T15:49 | 1 / 1 | 1 (0) | 1 | 0 / 0 |

Total 32; unmarked 0. Rows 28–31 were made by the repeatable browser check on 29 Oct; row 32 is the owner's acceptance record for reply tracking.

## 30 Oct 2026 — status after schema v15

Sign-in and ownership exist now (`docs/access-control.md`). **None of the records listed above was assigned**: they have no owner row and are invisible to Buyer A, Buyer B and the Approver. This includes the two real Sandbox payment records (USD 1.00, USD 12.00), which stay PAID and unchanged. Assigning any of them needs the owner's explicit choice and an operator step (not built; there is no client-side ownership change). New demo records for the acceptance come from `npm run accounts:seed-demo`.
