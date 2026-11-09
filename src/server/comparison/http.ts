// HTTP layer for the comparison (local dev only; same guard as the quote and extraction APIs).
//
//   GET …/versions/:versionId/comparison[?run=qx_…[&baseRun=qx_…]]
//
// GET only: there is nothing to start. The query names ids; the server reads every value itself.
// 200 { choices } without run · 200 { comparison, choices } · 409 { code } when the run cannot be the basis
// (other version, hash or snapshot mismatch, unfinished, older value-check rules) · 422 · 404.

import { EXTRACTION_RUN_ID } from "../../lib/extraction.ts";
import { QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { ComparisonService } from "./service.ts";

export type ComparisonSource = ComparisonService | (() => ComparisonService);
const resolve = (s: ComparisonSource) => (typeof s === "function" ? s() : s);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request, quote, version or extraction." });

export async function handleComparison(req: Request, requestId: string, seriesId: string, versionId: string, source: ComparisonSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, "Comparison API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !QUOTE_VERSION_ID.test(versionId)) return notFound();
  const params = new URL(req.url).searchParams;
  const unknown = [...params.keys()].filter((k) => k !== "run" && k !== "baseRun");
  if (unknown.length > 0) return json(422, { ok: false, code: "VALIDATION_FAILED", message: `Unknown parameter(s): ${unknown.join(", ")}. Only run and baseRun can be named; the server reads everything else.` });
  const run = params.get("run");
  const baseRun = params.get("baseRun");
  if ((run !== null && !EXTRACTION_RUN_ID.test(run)) || (baseRun !== null && !EXTRACTION_RUN_ID.test(baseRun)) || (baseRun !== null && run === null)) {
    return json(422, { ok: false, code: "VALIDATION_FAILED", message: "run / baseRun must be extraction run ids (baseRun only together with run)." });
  }
  const outcome = resolve(source).compare(who, requestId, seriesId, versionId, run, baseRun);
  switch (outcome.status) {
    case "NOT_FOUND":
      return notFound();
    case "CHOOSE":
      return json(200, { ok: true, choices: outcome.choices });
    case "REFUSED":
      return json(409, { ok: false, code: outcome.code, message: `This run cannot be used for a comparison (${outcome.code}). It can still be viewed in the extraction panel.`, choices: outcome.choices });
    case "OK":
      return json(200, { ok: true, comparison: outcome.comparison, choices: outcome.choices });
  }
}
