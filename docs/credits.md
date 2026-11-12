# Credits and third-party notices

TradeProof's own code and documentation: [MIT License](../LICENSE), Copyright (c) 2026 Asher Zhu. The MIT licence
covers only material the author can license. Everything below keeps its own licence or terms; nothing here is
relicensed. Licence data as declared by each package or project (checked 9 Nov 2026, SGT); this list is not legal
advice.

## 1. Application — direct dependencies (`package.json`, exact versions from `package-lock.json`)

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| `next` | 16.4.2 | MIT | web framework (App Router, dev server, build) |
| `react`, `react-dom` | 19.3.1 | MIT | UI |
| `@paypal/paypal-server-sdk` | 2.5.0 | MIT | PayPal Orders v2 (Sandbox) |
| `@anthropic-ai/sdk` | 1.3.0 | Apache-2.0 | Claude API client (real extraction / Copilot, only when configured) |

Development only (not part of the running app): `typescript` (Apache-2.0), `eslint` (MIT), `eslint-config-next`
(MIT), `@types/node`, `@types/react`, `@types/react-dom` (MIT).

## 2. Application — full production dependency tree (`npm ci`, lockfile)

Counted from `package-lock.json` (non-dev entries, including optional platform packages, most of which are not
installed on a given machine):

| Licence (as declared) | Packages |
| --- | --- |
| MIT | 62 (+10 optional) |
| Apache-2.0 | 4 (+14 optional) |
| ISC | 1 (+1 optional) |
| BSD-3-Clause | 1 (`source-map-js`) |
| 0BSD | 1 (`tslib`) |
| Unlicense | 1 (`fast-sha256`) |
| CC-BY-4.0 | 1 (`caniuse-lite`, browser-support data; attribution: the Can I Use project) |
| LGPL-3.0-or-later, alone or combined with Apache-2.0 / MIT | 14 **optional** platform binaries of `sharp` / libvips (Next.js image optimisation; installed only for the local platform, not committed, not used by TradeProof's pages) |

No dependency code, binary, font, image or media file is committed to this repository; dependencies are installed
by `npm ci` from the npm registry under their own licences.

`package.json` pins `follow-redirects` (MIT, a transitive dependency of the PayPal SDK via `axios`) to the patched
1.16.2 with an npm `overrides` entry — see `docs/security/follow-redirects-2026-11-09.md`.

## 3. Services and models used by the application

| Service / model | Terms | How TradeProof uses it |
| --- | --- | --- |
| PayPal Developer Platform — **Sandbox**, Orders v2 API | PayPal developer terms (the user's own Sandbox account) | create / capture / verify orders for the approved amount; Sandbox only, never PayPal Live |
| Anthropic Claude API — model `claude-sonnet-5-5` in the recorded real runs | Anthropic API terms (the user's own API key) | optional: extraction of pasted quotes and Copilot explanations; never needed for the MOCK demo |

The MOCK demo makes **no** call to either service.

## 4. Data

All requests, quotes, supplier replies and MOCK model outputs in `samples/synthetic/` were written for this project,
are fictional and are marked SYNTHETIC / DEMO. No real supplier, buyer or personal data is included.

## 5. Demo video (made with separate tools; not part of the application or this repository)

The video file itself is published separately (YouTube), not in this repository.

| Item | Version / source | Licence / terms (as read) | Use |
| --- | --- | --- | --- |
| Screen footage and screenshots | recorded from TradeProof (MOCK databases, SYNTHETIC data), 8–9 and 11 Nov 2026 | the author's own material | all app scenes |
| Remotion (`remotion`, `@remotion/cli`, `@remotion/media`) | 4.0.538 | Remotion License — Free License tier (individual); source-available, not open source | video editing / rendering |
| FFmpeg (bundled with Remotion's compositor) | n7.1 build in `@remotion/compositor-win32-x64-msvc` 4.0.538 | GPL build (libx264) | encoding, used locally; not redistributed |
| React, TypeScript (video project) | 19.1.1, 5.9.2 | MIT, Apache-2.0 | composition code |
| Voice: Kokoro-82M (ONNX v1.0 export) | `hexgrad/Kokoro-82M`; ONNX from `onnx-community/Kokoro-82M-v1.0-ONNX` @ `1939ad2a`; voices `af_heart` (narrator) and `af_sky` at speed 1.05 (Copilot character, video v4) | Apache-2.0 (as stated in the model card) | offline text-to-speech narration and character voice (synthetic voices) |
| kokoro-onnx | 0.6.1 | MIT | local TTS runtime |
| onnxruntime | 1.31.1 | MIT | local inference |
| phonemizer; espeak-ng (via `espeakng-loader` 0.2.4) | 3.6.0 | GPL-3.0-or-later (phonemizer, espeak-ng); loader MIT | text → phonemes only, run locally; not redistributed |
| Fonts | Windows system fonts (Segoe UI) at render time | system fonts, not bundled | on-screen text |
| Music (video v4, 12 Nov 2026) | "Wandering" by Andrewkn, Freesound sound 455855 — https://freesound.org/people/Andrewkn/sounds/455855/ (Freesound HQ MP3 preview, SHA-256 `d1f043ac6c2f9ef6899ee03ff3fb48121fe17d2d0539017fa5e3a851ccb931b7`; licence read on the sound page 12 Nov 2026) | CC0 1.0 (public-domain dedication; no attribution required — credited anyway) | background music |
| Stock images, stock footage | none used | — | — |

The narration and the Copilot character's voice are synthetic (Kokoro), not recordings of a person; the Copilot character is drawn in code. PayPal and Claude appear in the video only
as the names of the services the project integrates with.

## 6. Development tools (not shipped)

| Tool | Terms | Use |
| --- | --- | --- |
| ChatGPT (OpenAI) | OpenAI's terms for the author's account | planning, requirement refinement, acceptance checklists, prompt drafting and review of written materials; not used to run the repository or its tests |
| Claude Code (Anthropic) | Anthropic's terms for the author's account | AI coding assistant: much of the local implementation, tests, documentation and the video production workflow, under the author's direction and review |
| Microsoft Edge (DevTools protocol) | Microsoft software licence | local browser checks (`scripts/e2e/`) and screen recording for the video |

TradeProof is an entry to the PayPal AI Hackathon (Sponsor: PayPal, Inc.; Administrator: Devpost). It has not been
certified or endorsed as a product by PayPal, Anthropic or OpenAI.
PayPal, Claude and ChatGPT are trademarks of their respective owners.
