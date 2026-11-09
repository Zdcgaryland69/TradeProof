# TradeProof — release readiness and plan · 3 Nov 2026 (SGT), decisions 9 Nov 2026 (§7)

**Status:** proposal. Nothing has been published, pushed, deployed, registered or paid for. No Git history was
rewritten and no remote exists. Sensitive findings below give **location and type only**, never values.

## 1. Repository check (local repo, `main`, 87 commits; 3 Nov 2026)

| Check | Method | Result |
| --- | --- | --- |
| Keys / secrets in tracked files and **all history** | every non-empty secret-type value of the local `.env.local` (PayPal client id / secret / payee id, model API key) searched in `git log --all -p` and in tracked files by a script that printed only counts | **0 occurrences** of each |
| Key-shaped strings | patterns for Anthropic keys, PayPal access tokens, private-key blocks, `KEY=value` lines | none (one `AI_API_KEY=" "` blank in `docs/demo-script.md`) |
| Passwords | password literals in code / tests | only test fixtures (`wrong-password-1`); real demo passwords never committed |
| Database / backups / evidence | files ever tracked in history | **none**: no `.sqlite`, backup, `data/`, `.env*` (except `.env.example`), report or evidence file was ever committed; `.gitignore` covers `data/`, `*.sqlite*`, `.env*`, keys, logs, local reports |
| PayPal identifiers | full 17-character order / capture ids in files and history | **none**; docs keep only 4-character suffixes (`docs/payment-validation.md` 3, `docs/setup-status.md` 3). Payee ids in tests are fake (`MOCK…`, `ABCD…`, `OTHE…`) |
| Model provider request ids | `req_011…` | **present**: `docs/live-model-acceptance.md` (5), `docs/setup-status.md` (2) — not secrets, but account-linked identifiers |
| Local machine paths / user name | `C:\Users\<user>\…`, scratchpad temp paths | **present** in `docs/setup-status.md` (≈ 10 lines) and in history (11 diff lines); `README.md` no longer has one |
| Personal data | e-mail addresses in files; commit metadata | files: only `@example.com`. **Every commit's author e-mail is a personal Gmail address** (one identity) |
| README independence | links from `README.md` / `docs/run-guide.md` | run instructions need no ignored file. **Other docs reference 52 paths under `data/`** (evidence, acceptance ids, `data/tools/verify-evidence.mjs`) that do not exist in a clone — historical evidence pointers, not run steps |
| Licence | repo root | **no licence file** (required: Official Rules, Repository Requirements) |
| Third-party material | tracked assets; dependency licences (lockfile, production tree) | no images, fonts or media tracked; samples are self-written SYNTHETIC text. Production dependencies: MIT 73, Apache-2.0 18, ISC 2, BSD-3-Clause 1, 0BSD 1, Unlicense 1, CC-BY-4.0 1 (`caniuse-lite`, data), LGPL-3.0-or-later only in **optional** platform binaries of `sharp` (Next.js image optimisation; not committed, not used by the app). Direct: `next` MIT, `react` / `react-dom` MIT, `@paypal/paypal-server-sdk` MIT, `@anthropic-ai/sdk` Apache-2.0 |
| Other tracked config | `config/claude-project-settings.json` | plugin marketplace reference only, no credential |

**Before publishing (owner decides; I will not do these without a go-ahead):**

1. Licence file (§3 decision 1).
2. Local paths and user name in `docs/setup-status.md`: redact in the working tree (simple commit). They remain in
   history unless history is rewritten or the repo is published as a fresh single-commit export — owner decision;
   recommended: fresh export repository (the existing history stays only in this local repository, which has no remote; no rewrite of this repo).
3. Author e-mail: publishing history publishes the personal Gmail in every commit. A fresh export can use a GitHub
   `noreply` address. Owner decision (part of decision 2).
4. Provider request ids: replace with `req_…` short forms in the public copy (low risk, recommended).
5. Evidence: the `data/` evidence stays private. If the submission should show evidence, add a curated, redacted
   `docs/evidence/` summary (no ids beyond short suffixes, no account data) — optional.

## 2. Options

### A. Local reproducible run (recommended for the submission)

The Official Rules (local copy saved 4 Oct 2026, kept outside the repository; the live Devpost pages
returned HTTP 403 to automated fetching on 3 Nov, so **not re-verified online today**) say a hosted URL is **not**
required: "complete setup and run instructions in your code repository" satisfy the demo requirement, together with
"any test account credentials, API keys, or sandbox login details necessary to run and test the Project", and the
project must stay available free of charge until the judging period ends (15 Dec 2026, 8:00 am PT).

What A needs (mostly done today): `README.md`, `docs/run-guide.md`, `mock:*` safe mode (no keys needed, judges create
their own local accounts), `.env.example`, a licence, a public repository, the < 3-minute YouTube video. Cost: none.
Judges cannot reproduce the real-model or Sandbox runs without their own keys — the README says so and points to the
separate evidence; the MOCK path demonstrates every screen. **Open risk:** the guide was verified on Windows only; a
judge on macOS / Linux is untested (commands are cross-platform Node, but not checked).

### B. Controlled online demo (optional; needs code changes after the freeze → owner decision)

**Current code does not allow it:** `src/proxy.ts` refuses all procurement pages and APIs in production builds and for
any non-loopback Host (by design, 22–30 Oct). A hosted demo therefore needs a deliberate change and its own review:

| Topic | Today (local) | Needed online |
| --- | --- | --- |
| Gate | dev server, loopback only | production build allowed behind an explicit `TRADEPROOF_HOSTED_DEMO` switch, Host allow-list for the one public hostname |
| Storage | one SQLite file (WAL) on the local disk | a **persistent disk** mounted at the data path; single instance only (SQLite); daily copy of the file (`VACUUM INTO`) downloaded off the host |
| HTTPS / cookies | http on 127.0.0.1, cookies not `Secure` | platform TLS; cookies become `Secure` automatically over HTTPS (`cookieSecure`) — to be tested |
| Accounts | 3 preset accounts, operator-created | separate demo database; one judge buyer + one judge approver account per judge group, passwords shared privately in the submission's testing instructions; no owner accounts, no main database copied |
| Model / Copilot | real model only with keys + budget | **MOCK only** online (no key on the host) — no spend, no abuse risk |
| Payments | Sandbox only on the main DB; MOCK on copies | **MOCK payments only** online (no PayPal credentials on the host); real Sandbox stays a local, separately evidenced test |
| Abuse limits | login attempt limit, approver-assignment limit | same, plus a platform request limit if offered; demo data reset script |
| Webhook | none implemented; capture verified on the server | not needed for MOCK; a real Sandbox webhook would need a public HTTPS :443 listener and signature verification — **not feasible to build and verify before the 6 Nov freeze** without displacing checks |

Platform facts checked on 3 Nov 2026 from official pages (Render docs / FAQ; PayPal developer docs; Cloudflare docs):
Render **free** web services have **no persistent disk** (ephemeral filesystem, spin down after 15 min idle, ≈ 1 min
to wake) → a SQLite demo on the free tier loses data; disks are for **paid** services, limit the service to **one
instance** and disable zero-downtime deploys; every service gets an `onrender.com` HTTPS hostname; billing is prorated
by the second and persistent storage keeps billing until deleted. **Not verified** (pages not readable on 3 Nov):
Render paid instance and disk prices (search summary only: Starter ≈ US$7 / month, disk ≈ US$0.25 / GB / month),
the hackathon's Render credit amount, card requirement and expiry. PayPal webhooks: listener on HTTPS port 443, 2xx
required, retries up to 25 times over 3 days; verification via `verify-webhook-signature` with the webhook id;
simulator events cannot be verified by postback. Cloudflare Quick Tunnels need no account but are "for testing and
development", get a new hostname on every start and have no uptime guarantee — unsuitable for judging until 15 Dec.

Estimated cost of B if chosen (unverified prices): one small paid instance + 1 GB disk from ≈ 6 Nov to 15 Dec ≈
US$9–10, possibly covered by sponsor credits (unverified). Shutdown: delete the service **and** its disk after judging
(suspending stops compute only). Work: ≈ 1 day of code + review + checks — it competes with the 7–10 Nov checks.

**Recommendation:** submit with **A**. Do B only if the owner explicitly wants a hosted link, as a MOCK-only,
separate-database demo, decided before the 6 Nov freeze; otherwise state in the submission that judges run it locally.

## 3. Decisions for the owner (at most three) — decided 9 Nov, see §7

1. **Licence.** Recommended **MIT** (short, permissive, detected by GitHub, compatible with all current dependencies);
   Apache-2.0 is the alternative if an explicit patent grant matters. Not assumed — needs your choice and copyright name.
2. **How to publish the history.** Recommended: a **fresh public repository with one initial commit** of the cleaned
   tree (no local paths, no provider request ids, `noreply` author), this repository stays local only (no remote repository exists) and unchanged.
   Alternative: publish this history as is (exposes local paths and the personal author e-mail in old commits).
3. **Hosted demo or not.** Recommended: **no** hosted demo (option A). If yes: MOCK-only option B, decided by 6 Nov,
   with your approval of the platform, any card / credit claim and the cost cap.

Also needed from you later, not a decision: the presenter's checklist in `docs/demo-3min.md` (recording record), the
evidence card wording, and the video upload.

## 4. Remaining schedule (dates SGT; 11 Nov is the internal target, not a verified official deadline)

| Date | Work |
| --- | --- |
| 4 Nov | done: local release candidate + clean-copy verification (build vs `npm start` recorded apart), demo v4 timing on a rehearsal copy, display fix, official-rules check (online blocked, §5) |
| 4–5 Nov | owner, when free: recording-copy preparation (`docs/demo-3min.md` checklist), manual check of the live rules (§5), decisions 1–3 |
| **6 Nov** | **feature freeze** (defect fixes and wording only afterwards); licence file + public-copy redactions once decided |
| 7–10 Nov | staged checks: fresh-clone run again on the final commit, browser checks by impact, presenter prepares the recording record and records the video, submission text; 10 Nov full pre-submission check |
| **11 Nov** | internal submission target |
| 12 Nov | buffer (Official Rules: submissions close 12 Nov 2026, 12:00 pm PT = 13 Nov 04:00 SGT — from the local rules copy) |

## 5. Official requirements — what is confirmed (4 Nov 2026, SGT)

**Online check:** on 4 Nov the official pages `https://paypalaihackathon.devpost.com/rules`,
`https://paypalaihackathon.devpost.com/` and `https://paypalaihackathon.devpost.com/details/dates` returned **HTTP 403**
to automated fetching (same as 3 Nov). No workaround, mirror or cached copy was used. **So nothing below is confirmed as
the latest online version.** The only source read is the local copy of the Official Rules (`.docx`, file date
4 Oct 2026 21:05 SGT; kept outside the repository).

| Topic | Local Official Rules (4 Oct copy) say | Status |
| --- | --- | --- |
| Deadline | "Submission Period: Thursday Oct 1, 2026 (9:00 am Pacific Time) – Thursday Nov 12, 2026 (12:00 pm Pacific Time)" (= 13 Nov 2026, 04:00 SGT) | local copy only — **owner to check online** |
| Judging / availability | "Judging Period: Tuesday Dec 1, 2026 (2:00 pm Pacific Time) – Tuesday Dec 15, 2026 (8:00 am Pacific Time)"; the project must be available "free of charge and without any restriction … until the Judging Period ends" | local copy only |
| Repository | "Provide a URL to your public code repository for judging and testing on GitHub." "The repository must be public and open source by including an open source license file. This license should be detectable and visible at the top of the repository page (in the About section)." It "must contain all necessary source code, assets, and instructions required for the project to be functional." | local copy only |
| Video | "should be less than three (3) minutes. Judges are not required to watch beyond three minutes"; "should include footage that shows the Project functioning on the device for which it was built"; "must be uploaded to and made publicly visible on YouTube"; "must not include third party trademarks, or copyrighted music or other material unless the Entrant has permission" | local copy only |
| Hosting | "Your project does not need to be publicly hosted or deployed — but judges must be able to actually run or interact with a working build." It "can be satisfied through clear, complete setup and run instructions in your code repository … OR a hosted demo URL." | local copy only |
| Test access | "complete setup and run instructions … along with any test account credentials, API keys, or sandbox login details necessary to run and test the Project" | local copy only. MOCK mode needs no keys; judges create their own local accounts with `mock:accounts` (README says so) |
| Language | materials in English (or with an English translation) | local copy only |

**For the owner to check by hand on the live pages (signed in to Devpost), with the date you checked:**

1. Rules page — "Submission Period" end date / time / time zone; anything about extensions.
2. Rules page — "Repository Requirements": public GitHub repository; open-source licence file detectable in the About
   section.
3. Rules page — video: "less than three (3) minutes", "publicly visible on YouTube".
4. Rules page — "Provide access to a functional demo": "does not need to be publicly hosted" + run instructions accepted.
5. Rules page — "Testing": available free of charge until the Judging Period ends; credentials requirement.
6. Any "last updated" / change notice on the rules or updates page since 4 Oct.

The internal submission target stays **11 Nov 2026**; the earlier local reading of the deadline (13 Nov 04:00 SGT) is a
buffer, not a plan.

## 6. Local release candidate (4 Nov 2026) — not published

Built by `node scripts/release-candidate.mjs --out <folder> [--commit <rev>]` (tracked files of one commit only, so
`.env.local`, `data/` — databases, backups, sessions, accounts, evidence — `node_modules`, `.next` and scratch folders
cannot be included). Folder and its manifest are **outside** the repository and are not a Git repository:

- `…\Desktop\TradeProof-release\rc-2026-11-04-658753d\` + `rc-2026-11-04-658753d.manifest.json` (source commit,
  every file with SHA-256 and what was changed) + `rc-2026-11-04-658753d.scan.json` (remaining-pattern scan);
- a refreshed candidate from the 4 Nov final commit is listed in `docs/setup-status.md` (4 Nov) — same builder.

Left out (6 files): `docs/setup-status.md` (internal status log → replaced by a short stub so its 80 links still
resolve), the four raw logs in `docs/diagnostics/budget-threads-segfault-logs/` (the write-up stays, the crash is
listed as a known issue), `config/claude-project-settings.json` (coding-assistant tool config). Changed in the copy
only: 5 provider request ids → `req_…` (`docs/live-model-acceptance.md`), 1 local folder path of the rules file
(`docs/release-plan.md`). Scan after building: no local home path, user name, host name, author name or e-mail,
personal e-mail, key-shaped string, private-key block or filled secret line; none of the non-trivial values of
`.env.local` occurs in any file (checked by a separate script; only the public model name and the local base URL
occur, which are not secrets). Kept on purpose: run instructions, `.env.example` (empty values), SYNTHETIC samples,
tests, e2e scripts, design and evidence documents, known issues. `data/…` references in older documents point to
local evidence that is not published (stated in the stub).

**Not decided (owner) on 4 Nov — decided 9 Nov, see §7:** licence and copyright line (MIT with the owner as copyright holder is only a proposal — no licence
file was added), fresh public repository vs publishing this history, hosted demo. The repository itself, its history, backups
and evidence are unchanged; nothing was pushed or published.

## 7. Owner decisions and release preparation (9 Nov 2026, SGT)

**Decisions confirmed by the owner (9 Nov):**

1. Licence: **MIT**, `Copyright (c) 2026 Asher Zhu` → `LICENSE` added; `package.json` `"license": "MIT"`. The MIT
   licence covers only material the author can license; third-party notices in `docs/credits.md`.
2. Publication: a **new public repository named `TradeProof`** containing only the cleaned candidate as one initial
   commit; this local repository and its history stay as they are (no rewrite, no remote).
3. No hosted deployment; reproducible local MOCK run instructions (option A).
4. YouTube: the owner's own account; for now only the publishing material is prepared (`docs/submission/youtube.md`).

**Not authorised (9 Nov):** creating the remote repository, push, video upload, public release, submitting the
Devpost form. **Open:** the public commit author e-mail (no public / noreply address has been confirmed — the
personal Gmail must not be used by default), final approval of the repository and video publication.

**Official rules — online check 9 Nov 2026 (~20:27 SGT by the machine clock).** Unlike 3–4 Nov, the live pages
answered HTTP 200 to a plain request (no challenge page, nothing bypassed): `/rules`, the overview page, `/updates`
(saved locally outside the repository, with SHA-256). Read from the live text:

| Topic | Live rules / overview, 9 Nov | Compared with the 4 Oct local copy |
| --- | --- | --- |
| Submission Period | Oct 1, 2026 (9:15 am PT) – **Nov 12, 2026 (12:00 pm PT)**; overview "Deadline: Nov 12, 2026 @ 12:00pm PST" | end unchanged (= 13 Nov 04:00 SGT); start time now 9:15 am (was 9:00) |
| Judging Period | Dec 1, 2026 (2:00 pm PT) – Dec 15, 2026 (8:00 am PT) | unchanged |
| Repository | public on **GitHub, Bitbucket or GitLab**; all source, assets, instructions; open-source licence file detectable in the About section | hosts widened (copy said GitHub) |
| Functional demo | run instructions in the repository **or** a hosted URL; "a design mockup, static prototype, or non-functional demo does not meet this requirement" | unchanged in substance |
| Text description + **Tools** | describe features; overview: "identify which tools (model or AI service) were used and explain how" | Tools item now explicit on the overview → covered in `docs/submission/devpost.md` |
| Video | < 3 minutes; shows the project functioning; uploaded to YouTube, **publicly visible**; no third-party trademarks / copyrighted music without permission | unchanged |
| Testing | free of charge until the Judging Period ends; credentials / keys / sandbox details or clear instructions in the README | unchanged |
| Language | English (or English translation) | unchanged |
| Updates page (latest "4 days ago") | checklist: PayPal + AI, run instructions or URL, public repo with README + licence, public YouTube < 3 min, sponsor tools on the form if competing for a sponsor prize; "keep your demo, test credentials … active until winners are announced" | new guidance, consistent with the plan |

Still for the owner to check signed in (form fields only visible there): the submission form fields (e.g. "Built
with", sponsor tools, testing instructions), team / eligibility details, and any change after 9 Nov.

**Release candidate 9 Nov:** tested `rc-2026-11-09-aeb9898` (results: `docs/run-guide.md` §11); final candidate = rebuilt
from the docs-only follow-up commit (file list with SHA-256 and manifest diff: `…\Desktop\TradeProof-release\RELEASE-FILES-2026-11-09.md`,
outside the repository). Release Git repository not initialised (author e-mail open).

**Later on 9 Nov — dependency advisory and material review.** `follow-redirects` GHSA-mrwp-f3q8-3g9p fixed by an
in-range override to 1.16.2 (`91834f6`; analysis `docs/security/follow-redirects-2026-11-09.md`; only the trigger-free
Sandbox path ever uses the package). Materials aligned (`1c75e7b`): AI use split into product / development (Claude
Code) / video voice / MOCK vs real; one short independence + trademark line; Sandbox wording in title and tagline;
boundaries added to the Devpost text. Tested candidate `rc-2026-11-09-1c75e7b` (results `docs/run-guide.md` §11);
final candidate = rebuilt from the docs-only follow-up commit; list `…\Desktop\TradeProof-release\RELEASE-FILES-2026-11-09b.md`;
review pack `…\Desktop\TradeProof-release\REVIEW-PACK-2026-11-09.md`. Still not authorised: remote, push, upload,
publication, Devpost submission. Author e-mail still open (decided later the same evening, §8).

## 8. Round C — author identity, wording, sponsor tools, YouTube disclosure, cover (9 Nov 2026, late evening SGT)

**Decided by the owner:**

1. Public commit identity: **Asher Zhu** with the author's own e-mail address, set only in the separate release
   repository's local Git config (not global, not this repository). The owner knows the address becomes visible in the
   public commit.
2. A–E content direction accepted; the **English full text is not yet finally accepted**.
3. APIMatic: **not selected and not claimed**. Evidence collected: every source file of the official
   `@paypal/paypal-server-sdk` 2.5.0 (391 `.ts` files, package author PayPal) carries the header "automatically
   generated by APIMATIC v3.0"; TradeProof's own code never references `@apimatic`. The local copy of the Official
   Rules names "All Eligible Submissions that use any APIMatic tools" as the prize population without defining "use";
   an indirect dependency generated by APIMatic is not taken as proof of meeting it.
4. YouTube "Altered or synthetic content": assessment against YouTube's help page in `docs/submission/youtube.md`
   (answer is the owner's).
5. Cover: one local review draft authorised (real product frames; outside the repository; not uploaded).

**Wording corrected in this round:** the README and Devpost text now say first that the judges' default run and the
video are **MOCK mode**; "no Live" is limited to **PayPal Live**; the 21 Oct date is labelled as the first commit of the
author's **local Git history**, not a Devpost date, and the public repository's single commit is explained; the
independence line no longer says "not sponsored by PayPal" (the Official Rules name **PayPal, Inc. as Sponsor** and
**Devpost as Administrator**) — it now says the project has not been certified or endorsed as a product. New YouTube
titles carried "MOCK demo" (97 and 79 characters) — superseded by the owner's chosen title in §9.

**Release repository:** built from the candidate of this commit; the mapping (source commit → candidate manifest →
release commit) is recorded outside the repository in `…\Desktop\TradeProof-release\RELEASE-MAP-2026-11-09.md`.
Still not authorised: remote, push, upload, publication, Devpost submission.

## 9. Round D — owner's text corrections (9 Nov 2026, late evening SGT)

The owner reviewed the English material; full-text acceptance waits for these corrections. Facts were re-checked in the
release code (read-only, no code changed):

1. **YouTube title** (owner's choice): "TradeProof | Quote Review, Human Approval & PayPal Sandbox — MOCK Demo" (70
   characters). "AI-checked" is not used: differences and approval checks are deterministic rules.
2. **Approval invalidation** — from `src/server/approval/service.ts` `validityProblems`: a request revision whose
   compared content changes (`requestFingerprint` leaves out title, timestamps, data source, revision counter), changed
   reviews of the bound run(s), a newer quote version, changed supplier statements, changed requirement
   classifications, payee or rules change, approver assignment removed, quote text hash mismatch; plus revocation.
   Wording now lists examples instead of "any later change".
3. **Unknown payment results** — from `src/server/payments/service.ts` (approval payments run with
   `noResendAfterUnknown`): an unknown capture is never sent again (not even with the same `PayPal-Request-Id`); check
   status only reads PayPal; an unknown order creation is not retried automatically — only an explicit buyer action
   repeats it with the same `PayPal-Request-Id`, and only within 5 h of the first attempt. Wording no longer says
   "never re-send after an unknown outcome".
4. **Inspiration** rewritten as possible situations and a stated design hypothesis; one-person narration ("I").
5. **AI tools:** ChatGPT added (planning, requirement refinement, acceptance checklists, prompts, material review; not
   used to run the repository or its tests); Claude Code = local implementation, tests, documentation and video
   production workflow; the author decided, authorised and did the manual acceptance. Trademark line includes ChatGPT.
6. **Extraction wording** separates kept values (excerpt found in the quote text) from unknown, missing or failed ones
   (`src/lib/extraction.ts` fact checks). **Test issues** state the actual evidence for exit 139 (26 Oct stress runs,
   ≈ 4 / 150 with several thread tests in one process; alone 200 / 200) and `EPERM` (seen once, 3 Nov, file re-run
   33 / 33; suspected cause fixed, not proven gone).

## 10. Approvals recorded (9 Nov 2026, late evening SGT)

**Materials approved by the author** (content only — this is not a publication authorisation):

| Item | Status |
| --- | --- |
| README, Devpost text, YouTube title and description, credits (round D text, incl. the extraction / Copilot check wording) | **approved** |
| YouTube "altered or synthetic content" answer | **Yes** (author's decision) |
| Final video, narration, captions | unchanged (accepted earlier) |
| Cover | **A chosen** (`cover-a.png`, SHA-256 `686a6e53…9446`); B kept as an alternative; first draft superseded |

**Publication authorisations** (separate from the material approval):

| Step | Status |
| --- | --- |
| Create the public GitHub repository `TradeProof` under the author's own account | **done** 9 Nov — https://github.com/Zdcgaryland69/TradeProof (account confirmed by the author) |
| Push the cleaned, manifest-matched release repository (never the development history; no force-push) | **done** 9 Nov — initial commit `2581ed0`, normal push |
| Upload the accepted video publicly to the author's YouTube channel with the approved title, description, English captions, cover A and AI-use answer Yes | **done** 9–10 Nov — https://youtu.be/UOTZpzaLUCY (channel confirmed by the author); record in `docs/submission/youtube.md` |
| Replace link placeholders with the real public links and push the update as a normal new commit | **done** — this update, normal commit |
| Fill in the Devpost form | preparation only; **not** submitted, eligibility not confirmed on the author's behalf |

Option A (temporarily removing the repository line from the YouTube description) was authorised but **not used**: the
video was already public with the full approved description and a clickable link when it was checked.

After publication the public history is never amended or force-pushed. Sign-in, captcha and account verification
are done by the author; no password or token is requested.
