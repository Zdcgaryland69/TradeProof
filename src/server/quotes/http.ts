// HTTP layer for supplier quotes (local dev only, same guard as the procurement API).
//
//   GET  /api/procurements/:id/quotes                                  series + version summaries
//   POST /api/procurements/:id/quotes                                  new series with version 1
//   POST /api/procurements/:id/quotes/:seriesId/versions               new version (revision or supplement)
//   GET  /api/procurements/:id/quotes/:seriesId/versions/:versionId    one version with raw text + request snapshot
//
// POST results: 201 CREATED · 200 REPLAYED (same idempotency key + same content: the original save) ·
// 409 REQUEST_CHANGED / VERSION_CONFLICT (nothing saved; the client keeps the text) ·
// 422 VALIDATION_FAILED / IDEMPOTENCY_KEY_REUSED · 404 when the request / series / version do not belong together.

import type { FieldError } from "../../lib/procurement.ts";
import { MAX_QUOTE_BODY_BYTES, QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { canReadRequest, canWriteRequest } from "../access/policy.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { readJsonBody } from "../procurement/http.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { QuoteStore, SaveOutcome } from "./store.ts";
import { validateNewSeries, validateNewVersion } from "./validate.ts";

export type QuoteStoreSource = QuoteStore | (() => QuoteStore);

const LABEL = "Quote API";

function resolve(source: QuoteStoreSource): QuoteStore {
  return typeof source === "function" ? source() : source;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function notFound(): Response {
  return json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request, quote or version." });
}

function invalid(errors: FieldError[]): Response {
  return json(422, { ok: false, code: "VALIDATION_FAILED", message: "Some fields need attention. Nothing was saved.", errors });
}

function reply(outcome: SaveOutcome): Response {
  switch (outcome.status) {
    case "CREATED":
      return json(201, { ok: true, code: "CREATED", message: `Saved as version ${outcome.version.versionNumber}.`, series: outcome.series, version: outcome.version });
    case "REPLAYED":
      return json(200, {
        ok: true,
        code: "REPLAYED",
        message: `Already saved as version ${outcome.version.versionNumber} (this was a repeat of the same save).`,
        series: outcome.series,
        version: outcome.version,
      });
    case "KEY_REUSED":
      return json(422, { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This save key was already used for different content. Nothing was saved." });
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(outcome.errors);
    case "REQUEST_CHANGED":
      return json(409, {
        ok: false,
        code: "REQUEST_CHANGED",
        message: `The procurement request was updated (now revision ${outcome.currentRevision}) after this page loaded. Nothing was saved; your text is kept.`,
        currentRevision: outcome.currentRevision,
      });
    case "VERSION_CONFLICT":
      return json(409, {
        ok: false,
        code: "VERSION_CONFLICT",
        message: `Version ${outcome.latest.versionNumber} of this quote was saved elsewhere after you started. Nothing was saved; your text is kept.`,
        latest: outcome.latest,
      });
  }
}

async function bodyOf(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  return readJsonBody(req, MAX_QUOTE_BODY_BYTES);
}

export async function handleListQuotes(req: Request, requestId: string, source: QuoteStoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !canReadRequest(who, requestId)) return notFound();
  return json(200, { ok: true, series: resolve(source).listSeries(requestId) });
}

export async function handleCreateSeries(req: Request, requestId: string, source: QuoteStoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !canWriteRequest(who, requestId)) return notFound();
  const body = await bodyOf(req);
  if (!body.ok) return body.response;
  const checked = validateNewSeries(body.value);
  if (!checked.ok) return invalid(checked.errors);
  return reply(resolve(source).createSeries(requestId, checked.value));
}

export async function handleAddVersion(req: Request, requestId: string, seriesId: string, source: QuoteStoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !canWriteRequest(who, requestId)) return notFound();
  const body = await bodyOf(req);
  if (!body.ok) return body.response;
  const checked = validateNewVersion(body.value);
  if (!checked.ok) return invalid(checked.errors);
  return reply(resolve(source).addVersion(requestId, seriesId, checked.value));
}

export async function handleGetVersion(
  req: Request,
  requestId: string,
  seriesId: string,
  versionId: string,
  source: QuoteStoreSource,
  opts: GuardOptions,
): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !QUOTE_VERSION_ID.test(versionId) || !canReadRequest(who, requestId)) return notFound();
  const version = resolve(source).getVersion(requestId, seriesId, versionId);
  return version ? json(200, { ok: true, version }) : notFound();
}
