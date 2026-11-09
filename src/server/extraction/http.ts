// HTTP layer for AI extraction of a saved quote version (local dev only; same guard as the quote API).
//
//   GET  …/versions/:versionId/extractions                         config state (names only) + runs + reviews + supplier numbers
//   POST …/versions/:versionId/extractions                         { idempotencyKey, rerun? } → run (the only way a model call starts)
//   POST …/versions/:versionId/extractions/:extractionId/reviews   { idempotencyKey, fieldPath, action, valueText?, requestItemId?, basedOnReviewId }
//
// The body never carries quote text, version numbers, hashes or item lists: the server reads them. Unknown
// fields are refused. Run results: 201 (finished; see run.status — FAILED is reported, never shown as success) ·
// 200 REPLAYED · 409 IN_PROGRESS / ALREADY_EXTRACTED · 429 LIMIT_REACHED / BUDGET_EXHAUSTED ·
// 503 NOT_CONFIGURED / BUDGET_NOT_CONFIGURED / BUDGET_UNAVAILABLE (ledger not writable; run FAILED, nothing sent) · 422 · 404.

import { EXTRACTION_RUN_ID, EXTRACTION_REVIEW_ID, REVIEW_ACTIONS, type ReviewAction } from "../../lib/extraction.ts";
import { IDEMPOTENCY_KEY, QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { readJsonBody } from "../procurement/http.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { ExtractionService } from "./service.ts";

export type ServiceSource = ExtractionService | (() => ExtractionService);
const LABEL = "Extraction API";
const MAX_BODY = 16 * 1024;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const resolve = (s: ServiceSource) => (typeof s === "function" ? s() : s);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request, quote, version or extraction." });
const invalid = (message: string) => json(422, { ok: false, code: "VALIDATION_FAILED", message });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function ids(requestId: string, seriesId: string, versionId: string): boolean {
  return PROCUREMENT_ID.test(requestId) && QUOTE_SERIES_ID.test(seriesId) && QUOTE_VERSION_ID.test(versionId);
}

export async function handleListExtractions(req: Request, requestId: string, seriesId: string, versionId: string, source: ServiceSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!ids(requestId, seriesId, versionId)) return notFound();
  const data = resolve(source).list(who, requestId, seriesId, versionId);
  return data ? json(200, { ok: true, ...data }) : notFound();
}

export async function handleRunExtraction(req: Request, requestId: string, seriesId: string, versionId: string, source: ServiceSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!ids(requestId, seriesId, versionId)) return notFound();
  const body = await readJsonBody(req, MAX_BODY);
  if (!body.ok) return body.response;
  const b = body.value;
  if (!isObject(b)) return invalid("Body must be a JSON object.");
  const unknown = Object.keys(b).filter((k) => k !== "idempotencyKey" && k !== "rerun");
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}. The server reads the quote text, version and request snapshot itself.`);
  if (typeof b.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(b.idempotencyKey)) return invalid("A run key (UUID) is required.");
  if (b.rerun !== undefined && typeof b.rerun !== "boolean") return invalid("rerun must be true or false.");

  const outcome = await resolve(source).run(who, requestId, seriesId, versionId, { idempotencyKey: b.idempotencyKey.toLowerCase(), rerun: b.rerun === true });
  switch (outcome.status) {
    case "NOT_FOUND":
      return notFound();
    case "NOT_CONFIGURED":
      return json(503, { ok: false, code: "NOT_CONFIGURED", message: outcome.config.state === "NOT_CONFIGURED" ? outcome.config.message : "Not configured.", config: outcome.config });
    case "INPUT_TOO_LONG":
      return json(422, { ok: false, code: "INPUT_TOO_LONG", message: outcome.message });
    case "BUDGET_NOT_CONFIGURED":
      return json(503, {
        ok: false,
        code: "BUDGET_NOT_CONFIGURED",
        message: `No approved API budget, so no real model call is made. ${outcome.problems.join(" ")}`.trim(),
        missing: outcome.missing,
      });
    case "KEY_REUSED":
      return json(422, { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This run key was already used for a different request. Nothing was run." });
    case "REPLAYED":
      return json(200, { ok: outcome.run.status !== "FAILED", code: "REPLAYED", message: "This was a repeat of an earlier click; no new model call was made.", run: outcome.run });
    case "IN_PROGRESS":
      return json(409, { ok: false, code: "IN_PROGRESS", message: "An extraction of this version is already running. No second call was made.", run: outcome.run });
    case "ALREADY_EXTRACTED":
      return json(409, {
        ok: false,
        code: "ALREADY_EXTRACTED",
        message: "This version was already extracted with the same model and prompt. Running again is a new model call; confirm it explicitly.",
        run: outcome.run,
      });
    case "LIMIT_REACHED":
      return json(429, { ok: false, code: "LIMIT_REACHED", message: `Run limit reached for this version (${outcome.count} in the last 24 h). Nothing was run.` });
    case "FINISHED": {
      const r = outcome.run;
      if (r.status === "FAILED" && r.attempts === 0 && (r.errorCode === "BUDGET_EXHAUSTED" || r.errorCode === "BUDGET_DUPLICATE")) {
        return json(429, { ok: false, code: r.errorCode, message: `${r.errorMessage ?? "Budget limit reached."} No model call was made.`, run: r });
      }
      if (r.status === "FAILED" && r.attempts === 0 && r.errorCode === "BUDGET_UNAVAILABLE") {
        return json(503, { ok: false, code: r.errorCode, message: `${r.errorMessage ?? "The budget ledger could not be written."} No model call was made.`, run: r });
      }
      const message =
        r.status === "SUCCEEDED"
          ? "Extraction finished. A source excerpt was found in this version's text for every value — review required: code did not verify the meaning or which item a value belongs to."
          : r.status === "INCOMPLETE"
            ? "Extraction finished, but some values were not found in this version's text or were ambiguous, and were not saved as facts."
            : `Extraction failed (${r.errorCode}). Nothing from this run is shown as a result.`;
      return json(201, { ok: r.status !== "FAILED", code: r.status, message, run: r });
    }
  }
}

export async function handleReviewExtraction(
  req: Request,
  requestId: string,
  seriesId: string,
  versionId: string,
  extractionId: string,
  source: ServiceSource,
  opts: GuardOptions,
): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!ids(requestId, seriesId, versionId) || !EXTRACTION_RUN_ID.test(extractionId)) return notFound();
  const body = await readJsonBody(req, MAX_BODY);
  if (!body.ok) return body.response;
  const b = body.value;
  if (!isObject(b)) return invalid("Body must be a JSON object.");
  const allowedKeys = ["idempotencyKey", "fieldPath", "action", "valueText", "requestItemId", "basedOnReviewId"];
  const unknown = Object.keys(b).filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}.`);
  if (typeof b.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(b.idempotencyKey)) return invalid("A save key (UUID) is required.");
  if (typeof b.fieldPath !== "string" || b.fieldPath.length > 200) return invalid("fieldPath is required.");
  if (!(REVIEW_ACTIONS as readonly unknown[]).includes(b.action)) return invalid(`action must be one of ${REVIEW_ACTIONS.join(", ")}.`);
  if (!("basedOnReviewId" in b) || (b.basedOnReviewId !== null && (typeof b.basedOnReviewId !== "string" || !EXTRACTION_REVIEW_ID.test(b.basedOnReviewId)))) {
    return invalid("basedOnReviewId is required (null when this field has no review yet).");
  }
  let valueText: string | null = null;
  if (b.action === "CORRECT") {
    if (typeof b.valueText !== "string") return invalid("Enter the corrected value.");
    const v = b.valueText.trim();
    if (v === "" || [...v].length > 1000 || CONTROL.test(v) || !v.isWellFormed() || v.includes("\n")) return invalid("The corrected value must be one line of 1–1000 characters.");
    valueText = v;
  } else if (b.valueText !== undefined && b.valueText !== null) return invalid("valueText is only for CORRECT.");
  let requestItemId: string | null = null;
  if (b.action === "MATCH_ITEM") {
    if (typeof b.requestItemId !== "string") return invalid("Choose a request item.");
    requestItemId = b.requestItemId;
  } else if (b.requestItemId !== undefined && b.requestItemId !== null) return invalid("requestItemId is only for MATCH_ITEM.");

  const outcome = resolve(source).review(who, requestId, seriesId, versionId, extractionId, {
    idempotencyKey: b.idempotencyKey.toLowerCase(),
    fieldPath: b.fieldPath,
    action: b.action as ReviewAction,
    valueText,
    requestItemId,
    basedOnReviewId: b.basedOnReviewId as string | null,
  });
  switch (outcome.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(outcome.message);
    case "KEY_REUSED":
      return json(422, { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This save key was already used for a different review. Nothing was saved." });
    case "CONFLICT":
      return json(409, { ok: false, code: "REVIEW_CONFLICT", message: "This field was reviewed elsewhere after your page loaded. Nothing was saved.", latest: outcome.latest });
    case "CREATED":
      return json(201, { ok: true, code: "CREATED", message: "Review saved.", review: outcome.review });
    case "REPLAYED":
      return json(200, { ok: true, code: "REPLAYED", message: "Already saved (repeat of the same save).", review: outcome.review });
  }
}
