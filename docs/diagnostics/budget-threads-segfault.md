# Open issue: segmentation fault in the budget thread tests (26 Oct 2026)

**Status: OPEN — not fixed, cause not known.** Do not report the thread tests as fully stable. The separate
`database is locked` failure in the same tests is fixed (`4337435`, see `docs/setup-status.md`
"26 Oct — budget test: database lock fix"); this crash is a different problem.

## What happens

The test process ends with a **segmentation fault** (Git Bash exit **139**; under `node --test` the file is
reported only as `✖ tests\budget.test.ts … 'test failed'` with no sub-test results). No JavaScript error,
no assertion, no `database is locked`.

## Runtime

| | |
| --- | --- |
| Node | v24.19.0 (V8 13.6.233.17-node.51, libuv 1.52.1), x64 |
| SQLite (bundled `node:sqlite`) | 3.53.3 |
| npm | 11.17.0 |
| OS | Windows 11 (10.0.26300), Git Bash |
| `package.json` engines | `node >= 22.18.0` (Node was **not** upgraded or changed for this) |
| Code | fixed code at `4337435` (in a separate worktree, identical tree to `main` after the merge) |

## Commands used and results (26 Oct)

Thread group = the four tests in `describe("concurrent reservations across threads and connections")` of
`tests/budget.test.ts` (each spawns 10–12 `worker_threads` that open the same temp SQLite file).

| Command (env without `AI_*` / `ANTHROPIC_API_KEY`) | Runs | Result |
| --- | --- | --- |
| `node --test --test-name-pattern="concurrent reservations" tests/budget.test.ts` | 30 | 29 pass, **1 crash** (log A) |
| `node --test-name-pattern="concurrent reservations" tests/budget.test.ts` (in-process, no runner child) | 40 | 39 pass, **1 × exit 139** (log B: crashed after the 3rd test passed) |
| same, in-process | 80 | 78 pass, **2 × exit 139** (logs C, D: empty — crashed before the 1st test finished) |
| each thread test alone, in-process (`--test-name-pattern=<one test>`) | 4 × 50 | 200 / 200 pass, no crash |
| non-thread tests of the same file (`--test-name-pattern="lock held"`) | 80 | 80 / 80 pass |
| stand-alone scripts outside `node:test`: 12 workers per race with `node:sqlite` (exec only / prepared statements; `terminate()` / natural exit) | 9 × 150 races | 16,200 workers, no crash |
| stand-alone script with the real `tests/helpers/budget-worker.ts` + `BudgetStore` | 4 × 100 races | 4,800 workers, no crash |
| unchanged (pre-fix) code, in-process | 40 | 0 crashes, but 15 runs stopped early at the lock error — so whether the crash existed before is **unknown** |

**Combination that crashes:** several thread tests in **one** `node:test` process (≈ 4 / 150 ≈ 2.7 %).
Not seen with one thread test per process or outside `node:test` in the samples above.

## Logs

In `docs/diagnostics/budget-threads-segfault-logs/` (paths shortened to `<worktree>`; Node's
`MODULE_TYPELESS_PACKAGE_JSON` warnings removed): A = `node --test` run 18; B = in-process run 19 (three
`✔` lines, then the crash); C, D = in-process runs 64 and 78 (empty: nothing was printed before the crash).
No native stack or crash dump was captured.

## How to reproduce

```bash
npm run diag:budget-threads -- 100            # ORIGINAL combination, 100 runs; prints exit-code counts
npm run diag:budget-threads -- 100 --isolated # one process per thread test — ISOLATION for comparison, not a fix
```

At ≈ 2.7 % expect roughly 2–3 crashed runs per 100; 10 runs will usually show none (a 10-run smoke check on
26 Oct after the merge: 0 / 10). Temp databases only; no model, no PayPal, no real ledger.

## Not done (deliberately, this round)

No further stress runs, no Node upgrade, no change to how `npm test` runs the file (no isolation applied).
Possible next steps if the owner wants them: capture a native crash dump (e.g. Windows Error Reporting /
`procdump -e`) for one crashed run; search the Node issue tracker for `node:sqlite` + `worker_threads`
crashes on 24.x; only then decide between a code change and isolating the thread tests (which would be
labelled as isolation).

## Impact

The app does not use worker threads; the crash has been seen only in this test file's thread tests. The
reservation checks themselves (exactly N reserved, no duplicate rows) passed in every run that completed.
