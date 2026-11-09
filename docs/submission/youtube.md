# YouTube publishing material — DRAFT for the author's review (9 Nov 2026, SGT)

Status: draft. **Not uploaded.** The author uploads from their own YouTube account. Placeholders in `<…>`.

## Video and captions (final, accepted by the author on 9 Nov 2026)

| File (kept outside this repository) | Length / size | SHA-256 |
| --- | --- | --- |
| `tradeproof-demo-v2b-t4-af_heart-2026-11-09.mp4` | 2:36.7 (156.672 s), 1920×1080, 30 fps, H.264 + AAC 48 kHz stereo, 24,731,081 bytes | `bea6513b4cbd19caf97df7487018131728f33e2c908bbcee69de9d6337820942` |
| `tradeproof-demo-v2b-t4-af_heart-2026-11-09.srt` (English, 31 captions = the narration) | 2,924 bytes | `767d4a62531203ae8402ff363f11b13ef0f5b27ac3f517413ffce8581606013b` |

Check the hash before uploading (PowerShell: `Get-FileHash <file> -Algorithm SHA256`).

Upload settings to choose: visibility **Public** (required by the Official Rules); audience "not made for kids";
language English; captions: upload the `.srt` as **English** subtitles; category Science & Technology (suggestion);
"Altered or synthetic content" disclosure ("AI use" in the upload Attributes) — the author decides; basis below.

### Altered or synthetic content — assessment (9 Nov 2026, SGT)

Source: YouTube Help, "Disclosing use of altered or synthetic content",
<https://support.google.com/youtube/answer/14328491?hl=en> (read 9 Nov 2026; no last-updated date shown). The page
requires disclosure of AI content "that seems realistic", listing: making a real person appear to say or do something
they didn't, altering footage of a real event or place, generating a realistic scene that didn't occur, and AI music
as the main focus. "Non-realistic or minor edits don't" require it; production assistance (script, thumbnail, title),
caption creation and "cloning one's own voice to create voice overs or dubs" are listed as not requiring it.
Disclosing "alone won't limit a video's audience or impact its eligibility to earn money"; disclosed non-music AI
audio gets a label in the expanded description.

| Element of this video | AI-generated or altered? | Matches a "must disclose" case? |
| --- | --- | --- |
| Screen footage | No — real recordings of the real application (MOCK database, SYNTHETIC data, automated clicks); not edited by AI | No: no real event or place is altered and no scene is invented |
| Opening illustration (request vs quote) | No — drawn by code in Remotion, non-photorealistic | No: not realistic, not GenAI |
| Narration | Yes — offline TTS (Kokoro-82M, stock voice `af_heart`), not a clone of any real person | Not listed: it does not make a real person say anything. The page does not address a generic TTS narrator explicitly |
| Captions | Text of the narration | No: caption creation is listed as not requiring disclosure |

Assessment: by the listed criteria, disclosure does **not** appear to be required (the narration is the only AI
element and does not depict a real person); this is a reading of the help page, not a YouTube ruling. The description
already states that the narration is AI-generated. Answering "Yes" anyway would add a label in the description and,
per the page, does not limit reach or monetisation — either answer is consistent with what the video says about itself.

**Author's decision (9 Nov 2026): answer "Yes"** to the AI-use / altered-or-synthetic-content question when the
video is uploaded (the narration is synthetic). This records the answer only; uploading is a separate authorisation.

## Title (≤ 100 characters; counts measured)

Chosen by the author (9 Nov 2026):

> TradeProof | Quote Review, Human Approval & PayPal Sandbox — MOCK Demo — 70 characters (measured)

Not used: "AI-checked …" — the differences and the approval checks are decided by deterministic rules, not by AI.

## Description

```text
TradeProof helps a small business that buys samples or small batches from an overseas supplier: it keeps the
request, every quote version and every decision on one record. AI proposes values with their source lines, code
compares the quote with the request, people review and approve the exact conditions, and the payment follows the
saved approval — for exactly the approved amount (PayPal Sandbox in the product; simulated MOCK payment in
this video).

Built for the PayPal AI Hackathon 2026.

Chapters
0:00 The problem: a quote that does not match the request
0:22 Comparison with source lines and review status
0:42 Bilingual clarification and supplier replies
0:57 Revised request (sample order) and quote version 2
1:25 Approval by the assigned approver
1:42 Payment bound to the approval (MOCK)
2:13 What was tested for real, separately

What you see
- Real TradeProof application footage, recorded in MOCK mode on a database with SYNTHETIC (fictional) data. The
  extraction, Copilot answers and PayPal payment in the video are MOCK — no money moved.
- Some items were prepared before recording; on-screen actions were automated. Narration is AI-generated
  (synthetic voice).
- The payee is a fixed PayPal Sandbox test merchant from the server configuration, not the supplier. TradeProof is
  not escrow and never holds money.
- Tested separately (not one end-to-end run): a real model on synthetic quotes and Copilot test cases, and real PayPal
  Sandbox payments (USD 1.00; USD 12.00 after a human approval).

Code (MIT licence) and run instructions: <public GitHub repository URL>

Built with: PayPal Developer Platform (Sandbox, Orders v2), Anthropic Claude API, Next.js, React, TypeScript, SQLite.
Developed with Claude Code (AI coding assistant) and ChatGPT (planning and review).
Screen footage recorded from Microsoft Edge; video edited with Remotion; narration synthesised locally with
Kokoro-82M (Apache-2.0). No music, no stock footage.
An entry to the PayPal AI Hackathon (Sponsor: PayPal, Inc.; Administrator: Devpost); not certified or endorsed as
a product by PayPal, Anthropic or OpenAI. PayPal, Claude and ChatGPT are trademarks of their respective owners.
```

Chapter times are the scene starts of the final timeline (V1 0:00, V3 22.8 s, V4 42.4 s, V5 57.9 s, V7 85.5 s,
V8 102.6 s, V9 133.8 s), rounded down. Check them once against the uploaded video.

## Thumbnail (cover) — final: draft A (chosen by the author, 9 Nov 2026)

- **Final cover: `cover-a.png`** (1280×720 PNG, 159,787 bytes, SHA-256
  `686a6e53272c743d906765ad1e323f0cb519959a15131080b449b14543529446`). B is kept locally as an alternative. The first
  draft ("Check the quote. Approve exact terms.") was not accepted and is superseded.
- Brief (author, 9 Nov): brand **TradeProof**, headline "Know what you approve.", subtitle "Quote review · Human
  approval · Payment", a readable **MOCK DEMO** tag; deep navy with a small teal / brass accent; only real, accepted
  product screenshots (cropped, scaled, framed — no redrawn UI, no changed text or states); no PayPal logo, no
  certification, real-money or escrow suggestion; key content clear of the bottom-right duration overlay.
- A (brand-led): headline first, one real approval screen (approval page "Decision" card: Approved — Active, quote
  version 2, USD 68.00, approved by the assigned approver). B (product-led): the real version-1 comparison
  (Quantity 500 pcs vs 480, Material 304 vs 201 → "Difference") fills the frame; headline beside it.
- Both: 1280×720 PNG + 320×180 preview, kept outside this repository; rendered locally from HTML with headless
  Microsoft Edge (Bahnschrift, a Windows system font); frames from the accepted video's recordings (MOCK database,
  SYNTHETIC data). The video file itself is unchanged.
