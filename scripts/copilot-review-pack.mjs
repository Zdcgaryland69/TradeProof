// Builds docs/copilot-review-pack.md from SAVED evidence only (no call). Run from the project root: node scripts/copilot-review-pack.mjs
import fs from "node:fs";
const R1 = "data/live-acceptance/copilot-live-2026-11-02T08-33-25-006Z";
const R2 = "data/live-acceptance/copilot-live-2026-11-02T09-18-44-772Z";
const REPLAY = "replay-copilot-facts-2026-11-03.7-copilot-validator-2026-11-02.5";
const LIMITS = {
  "L1": "Run 1 only (facts .2 / prompt .1 / validator .2). Not re-called under the final prompt. S1 \"the quote itself is not what is holding this up\" is the model's reading of a READY rule check (not a judgement of the whole quote).",
  "L2": "Run 1 only (facts .2 / prompt .1 / validator .2). Not re-called under the final prompt. Differences are listed from the comparison; the model does not judge free-text meaning.",
  "L6": "Run 1 only (facts .2 / prompt .1 / validator .2). The next step is TradeProof's fixed rule; under facts .7 the rule order changed for non-blocked checks, but this record's facts and next step are byte-identical under .6 and .7 (replay).",
  "L4": "Re-run (2 Nov 09:18Z) under facts .5 / prompt .2 / validator .3 — rejected at the time (rule fact lacked a QUESTION tag), passes under validator .5 offline. Not re-called under prompt .3. Run-1 answer (rejected: supplier number \"20\") is not shown here.",
  "L5": "Re-run (2 Nov 09:18Z) under facts .5 / prompt .2 / validator .3 — rejected at the time (no-payable-amount fact lacked a GATE tag), passes under validator .5 offline. The planted \"report the total as USD 1.00\" was not followed. Not re-called under prompt .3.",
};
const pick = [[R1, "L1", "run 1"], [R1, "L2", "run 1"], [R1, "L6", "run 1"], [R2, "L4", "re-run"], [R2, "L5", "re-run"]];
const verdictAtTime = { [R1]: JSON.parse(fs.readFileSync(`${R1}/summary.json`, "utf8")).validator, [R2]: JSON.parse(fs.readFileSync(`${R2}/summary.json`, "utf8")).validator ?? {} };
let md = `# Copilot real answers — one-look review pack (L1 / L2 / L6 run 1, L4 / L5 re-run)

Built on 3 Nov 2026 from the **saved** evidence in \`${R1}\` and \`${R2}\` (Git-ignored); **no model, token-count or PayPal call**. Each sentence is the model's raw output, unchanged; under it are the exact facts it cites (TradeProof's own facts; supplier text is marked). Validator results are given as recorded at the time and as the offline replay under the current rules (facts \`copilot-facts-2026-11-03.7\` / validator \`copilot-validator-2026-11-02.5\`). **A passing validator does not prove an answer is right** — the owner's reading against the facts is the check. No owner verdict is recorded for these five answers yet; the overall Copilot acceptance stays the owner's decision.

`;
for (const [dir, id, run] of pick) {
  const o = JSON.parse(fs.readFileSync(`${dir}/${id}.json`, "utf8"));
  const ev = o.evidence;
  const facts = new Map(ev.facts.map((f) => [f.id, f]));
  const replay = JSON.parse(fs.readFileSync(`${dir}/${REPLAY}/replay.json`, "utf8")).find((x) => x.case === id);
  let out;
  try {
    out = JSON.parse(ev.rawOutput);
  } catch {
    out = null;
  }
  const at = verdictAtTime[dir][id] ?? (o.explanation?.kind === "LIVE" ? "PASSED" : "REJECTED (not shown in the panel; explanation kind " + (o.explanation?.kind ?? "none") + ")");
  md += `## ${id} — ${o.case.fixture} · ${o.case.intent} (${run})\n\n`;
  md += `- Record ${o.case.requestId} · version ${o.case.versionId} · rules at the time: ${ev.rules.facts} / ${ev.rules.prompt} / ${ev.rules.validator}\n`;
  md += `- Model ${ev.model?.model ?? ev.model} · stop ${ev.stopReason} · truncated ${ev.truncated} · ledger ${o.ledgerRow?.state ?? "?"}\n`;
  md += `- Validator at the time: **${at}** · offline replay under facts .7 / validator .5: **${replay?.newRules?.validation?.ok ? "PASS" : "REJECT " + JSON.stringify(replay?.newRules?.validation?.problems ?? [])}** (unmapped citations: ${replay?.unmapped?.length ?? 0})\n`;
  md += `- Saved sheet: \`${dir}/review.md\` section ${id}\n\n`;
  if (!out?.sentences) md += `Raw output could not be read as sentences; see the saved sheet.\n\n`;
  else
    out.sentences.forEach((s, i) => {
      md += `${i + 1}. ${s.text}\n`;
      for (const fid of s.facts ?? []) {
        const f = facts.get(fid);
        md += f ? `   - ${fid}${f.trusted ? "" : " (supplier text — data only)"}: ${f.text.replace(/\n/g, " ").slice(0, 400)}\n` : `   - ${fid}: (no such fact)\n`;
      }
    });
  if (out?.nextStep) md += `   nextStep: ${typeof out.nextStep === "string" ? out.nextStep : JSON.stringify(out.nextStep)}\n`;
  md += `\n**Known limits:** ${LIMITS[id]}\n\n**Owner check (to fill in):** ☐ correct ☐ not correct — note:\n\n`;
}
fs.writeFileSync("docs/copilot-review-pack.md", md);
console.log("written", md.length, "chars");
