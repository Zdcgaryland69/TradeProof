// Size and cost bounds of the six proposed real Copilot asks (L1–L6, revised 2 Nov, later) — computed WITHOUT any network call
// and WITHOUT a token count: the six SYNTHETIC records are seeded into a temporary database with the same helper the
// acceptance runner uses, the exact prompts are built, and the ledger's reservation rule is applied.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-cost-bounds.mts
//
// Three different measures, never mixed up:
//   - characters of the content package (the user message) — the 12,000 limit;
//   - UTF-8 bytes of system + user — used here as a PROVISIONAL input-token estimate (not proven for the tokenizer);
//   - tokens — only the provider's count at call time is used for the real reservation (+10 % +256, ×1.1).
// The real reservation is additionally capped at min(US$0.04, run cap − reserved so far); above that nothing is sent.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COPILOT_LIMITS } from "../src/lib/copilot.ts";
import { boundMicros, reservedInputTokens, type Prices } from "../src/server/budget/config.ts";
import { buildCopilot } from "../src/server/copilot/facts.ts";
import { buildCopilotPrompt } from "../src/server/copilot/prompt.ts";
import { seedAcceptanceCases } from "../tests/helpers/copilot-fixtures.ts";
import { P } from "../tests/helpers/approval-fixtures.ts";
import { openWorld } from "./copilot-world.mts";

/** As recorded in the ledger's price_basis for claude-sonnet-5-5 (25 Oct): USD per million tokens, in micro-units. */
const PRICES: Prices = { inputPerMTokMicros: 2_000_000, outputPerMTokMicros: 10_000_000, perRequestMicros: 0 };
const RUN_CAP_MICROS = 200_000;

// Largest provider token count whose reservation still fits the per-ask cap (for the record).
let maxCounted = 0;
while (boundMicros(PRICES, reservedInputTokens(maxCounted + 1), COPILOT_LIMITS.maxOutputTokens) <= COPILOT_LIMITS.maxReservedMicros) maxCounted += 1;

const dir = mkdtempSync(join(tmpdir(), "tradeproof-copilot-bounds-"));
const w = openWorld(join(dir, "bounds.sqlite"));
try {
  const cases = await seedAcceptanceCases(w, "bounds");
  let total = 0;
  console.log("case | intent | facts | package chars | prompt UTF-8 bytes | provisional input-token bound | output cap | reservation if the count equalled the byte estimate (USD)");
  for (const c of cases) {
    const built = buildCopilot(w.src, P, c.requestId, { seriesId: c.seriesId, versionId: c.versionId, runId: null, baseRunId: null }, c.intent)!;
    const prompt = buildCopilotPrompt(c.intent, built.facts, built.links, "000000000000");
    const bytes = Buffer.byteLength(prompt.system, "utf8") + Buffer.byteLength(prompt.user, "utf8");
    const inputBound = reservedInputTokens(bytes + 64);
    const micros = boundMicros(PRICES, inputBound, COPILOT_LIMITS.maxOutputTokens);
    total += micros;
    const flags = [prompt.bundleChars > COPILOT_LIMITS.maxBundleChars ? "OVER PACKAGE LIMIT" : "", micros > COPILOT_LIMITS.maxReservedMicros ? "OVER PER-ASK CAP" : ""].filter(Boolean).join(" ");
    console.log(`${c.id} ${c.fixture} | ${c.intent} | ${built.facts.length} | ${prompt.bundleChars} | ${bytes} | ${inputBound} | ${COPILOT_LIMITS.maxOutputTokens} | ${(micros / 1e6).toFixed(6)}${flags ? ` | ${flags}` : ""}`);
  }
  console.log(`sum: USD ${(total / 1e6).toFixed(6)} (run cap USD ${(RUN_CAP_MICROS / 1e6).toFixed(2)}, per-ask cap USD ${(COPILOT_LIMITS.maxReservedMicros / 1e6).toFixed(2)})`);
  console.log(`per-ask cap holds up to a provider count of ${maxCounted} input tokens (with max_tokens ${COPILOT_LIMITS.maxOutputTokens}); above that the ask is not sent`);
  console.log(`hard ceiling of the run: min(run cap, 6 × per-ask cap) = USD ${(Math.min(RUN_CAP_MICROS, 6 * COPILOT_LIMITS.maxReservedMicros) / 1e6).toFixed(2)} of reservations`);
} finally {
  w.close();
  rmSync(dir, { recursive: true, force: true });
}
