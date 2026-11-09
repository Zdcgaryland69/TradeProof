// HTTP layer for bilingual clarification drafts (local dev only; same guard as the quote and extraction APIs).
//
//   GET  …/versions/:versionId/clarification-drafts            drafts of this version (newest first)
//   POST …/versions/:versionId/clarification-drafts            { run, baseRun?, supersedes? } → draft (201 new · 200 existing)
//   GET  /api/procurements/:id/clarification-drafts/:draftId   draft, generated + latest text, basis status, check
//   PUT  /api/procurements/:id/clarification-drafts/:draftId   { saveKey, expectedRevision, content } → 200 SAVED / UNCHANGED / REPLAYED · 409
//
// The create body names ids only: amounts, quote text, findings and questions are read and generated on the
// server. A save carries the user's own texts and selection, which are validated, stored as the user's edit
// and checked — never used as amounts, terms or comparison results. Nothing here sends a message.

import { EXTRACTION_RUN_ID } from "../../lib/extraction.ts";
import { IDEMPOTENCY_KEY, QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { readJsonBody } from "../procurement/http.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { ClarificationService } from "./service.ts";
import { CLARIFICATION_DRAFT_ID } from "./store.ts";

export type ClarificationSource = ClarificationService | (() => ClarificationService);
const LABEL = "Clarification draft API";
const MAX_BODY = 128 * 1024;
const resolve = (s: ClarificationSource) => (typeof s === "function" ? s() : s);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request, quote, version, extraction or draft." });
const invalid = (message: string) => json(422, { ok: false, code: "VALIDATION_FAILED", message });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function handleListDrafts(req: Request, requestId: string, seriesId: string, versionId: string, source: ClarificationSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !QUOTE_VERSION_ID.test(versionId)) return notFound();
  const drafts = resolve(source).list(who, requestId, seriesId, versionId);
  return drafts ? json(200, { ok: true, drafts }) : notFound();
}

export async function handleCreateDraft(req: Request, requestId: string, seriesId: string, versionId: string, source: ClarificationSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !QUOTE_VERSION_ID.test(versionId)) return notFound();
  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return body.response;
  const b = body.value;
  if (!isObject(b)) return invalid("Body must be a JSON object.");
  const unknown = Object.keys(b).filter((k) => !["run", "baseRun", "supersedes"].includes(k));
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}. Name the run only; the server reads the comparison, values and texts itself.`);
  if (typeof b.run !== "string" || !EXTRACTION_RUN_ID.test(b.run)) return invalid("run must be an extraction run id.");
  if (b.baseRun !== undefined && b.baseRun !== null && (typeof b.baseRun !== "string" || !EXTRACTION_RUN_ID.test(b.baseRun))) return invalid("baseRun must be an extraction run id.");
  if (b.supersedes !== undefined && b.supersedes !== null && (typeof b.supersedes !== "string" || !CLARIFICATION_DRAFT_ID.test(b.supersedes))) return invalid("supersedes must be a draft id.");
  const outcome = resolve(source).create(who, requestId, seriesId, versionId, b.run, (b.baseRun as string | undefined) ?? null, (b.supersedes as string | undefined) ?? null);
  switch (outcome.status) {
    case "NOT_FOUND":
      return notFound();
    case "REFUSED":
      return json(409, { ok: false, code: outcome.code, message: `This run cannot be used for a comparison (${outcome.code}), so no draft was created.` });
    case "EXISTING":
      return json(200, { ok: true, code: "EXISTING", message: "A draft from the same comparison basis already exists; it was opened instead of creating another.", draftId: outcome.draft.id });
    case "CREATED":
      return json(201, { ok: true, code: "CREATED", message: "Template-generated draft created. Review it before sending — nothing was sent.", draftId: outcome.draft.id });
  }
}

export async function handleGetDraft(req: Request, requestId: string, draftId: string, source: ClarificationSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !CLARIFICATION_DRAFT_ID.test(draftId)) return notFound();
  if ([...new URL(req.url).searchParams.keys()].length > 0) return invalid("No query parameters are accepted.");
  const view = resolve(source).open(who, requestId, draftId);
  return view ? json(200, { ok: true, ...view }) : notFound();
}

export async function handleSaveDraft(req: Request, requestId: string, draftId: string, source: ClarificationSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !CLARIFICATION_DRAFT_ID.test(draftId)) return notFound();
  const body = await readJsonBody(req, MAX_BODY);
  if (!body.ok) return body.response;
  const b = body.value;
  if (!isObject(b)) return invalid("Body must be a JSON object.");
  const unknown = Object.keys(b).filter((k) => !["saveKey", "expectedRevision", "content"].includes(k));
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}.`);
  if (typeof b.saveKey !== "string" || !IDEMPOTENCY_KEY.test(b.saveKey)) return invalid("A save key (UUID) is required.");
  if (typeof b.expectedRevision !== "number" || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 1) return invalid("expectedRevision is required.");
  const outcome = resolve(source).save(who, requestId, draftId, b.expectedRevision, b.content, b.saveKey);
  switch (outcome.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(outcome.message);
    case "KEY_REUSED":
      return json(422, { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This save key was already used for different content. Nothing was saved." });
    case "CONFLICT":
      return json(409, { ok: false, code: "DRAFT_CONFLICT", message: `This draft was saved elsewhere (now revision ${outcome.current.revision}) after you opened it. Nothing was saved.`, current: outcome.current });
    case "UNCHANGED":
      return json(200, { ok: true, code: "UNCHANGED", message: "No changes to save.", revision: outcome.revision, check: outcome.check });
    case "REPLAYED":
      return json(200, { ok: true, code: "REPLAYED", message: "Already saved (repeat of the same save).", revision: outcome.revision, check: outcome.check });
    case "SAVED":
      return json(200, { ok: true, code: "SAVED", message: `Saved as revision ${outcome.revision.revision}. Nothing was sent.`, revision: outcome.revision, check: outcome.check });
  }
}
