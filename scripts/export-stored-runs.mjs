// One-off, read-only export of the stored real-model acceptance runs (LA-1 … LA-5, 25 Oct) into a test
// fixture, so the comparator tests run on exactly what was stored — without the local DB and without any
// model call. Usage: node scripts/export-stored-runs.mjs <path to a COPY of the DB> <output json>
// Exports per run: the run row (incl. checked result and raw model output), the version (text, hashes,
// request snapshot) and, for a supplement, its linked base version. Nothing is written to the DB.

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [file, out] = process.argv.slice(2);
if (!file || !out) throw new Error("usage: node scripts/export-stored-runs.mjs <db copy> <output json>");
const db = new DatabaseSync(file, { readOnly: true });

const versionOf = (id) => {
  const v = db.prepare(`SELECT v.*, s.request_id, (SELECT max(version_number) FROM quote_versions WHERE series_id = v.series_id) AS latest FROM quote_versions v JOIN quote_series s ON s.id = v.series_id WHERE v.id = ?`).get(id);
  const base = v.supplements_version_id ? db.prepare("SELECT version_number FROM quote_versions WHERE id = ?").get(v.supplements_version_id) : null;
  return {
    id: v.id,
    seriesId: v.series_id,
    requestId: v.request_id,
    versionNumber: v.version_number,
    latestVersionNumber: v.latest,
    contentKind: v.content_kind,
    supplementsVersionId: v.supplements_version_id,
    supplementsVersionNumber: base ? base.version_number : null,
    rawTextSha256: v.raw_text_sha256,
    requestRevision: v.request_revision,
    snapshot: JSON.parse(v.request_snapshot),
    rawText: v.raw_text,
  };
};

const runs = db
  .prepare("SELECT r.*, p.title FROM quote_extraction_runs r JOIN procurement_requests p ON p.id = r.request_id WHERE r.mode = 'LIVE' ORDER BY r.started_at")
  .all();
const cases = {};
for (const r of runs) {
  const key = /LA-\d/.exec(r.title)[0];
  const version = versionOf(r.version_id);
  cases[key] = {
    title: r.title,
    version,
    base: version.supplementsVersionId ? versionOf(version.supplementsVersionId) : null,
    run: {
      id: r.id,
      versionId: r.version_id,
      seriesId: r.series_id,
      requestId: r.request_id,
      inputSha256: r.input_sha256,
      requestRevision: r.request_revision,
      contextVersionId: r.context_version_id,
      mode: r.mode,
      provider: r.provider,
      model: r.model,
      promptVersion: r.prompt_version,
      schemaVersion: r.schema_version,
      status: r.status,
      interrupted: false,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      attempts: r.attempts,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      result: JSON.parse(r.result_json),
      rawOutput: r.raw_output,
    },
  };
}
db.close();
writeFileSync(
  out,
  JSON.stringify(
    {
      _notice:
        "SYNTHETIC test data. Read-only export (26 Oct 2026) of the five stored real-model acceptance runs (Anthropic claude-sonnet-5-5, 25 Oct; docs/live-model-acceptance.md) with their quote versions and request snapshots. Used by tests/comparison.test.ts; no model is called.",
      cases,
    },
    null,
    1,
  ) + "\n",
);
console.log(`exported ${Object.keys(cases).length} runs: ${Object.keys(cases).join(", ")}`);
