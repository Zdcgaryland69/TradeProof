// HTTP layer for supplier reply tracking (local dev only; same guard as the draft APIs).
//
//   POST /api/procurements/:id/quotes/:seriesId/replies                       { saveKey, rawText, receivedOn?, channelNote?, senderAsTyped?, correctsReplyId?, source? }
//                                                                            → 201 new (identical text under a new key = a new reply, flagged) · 200 replay
//   POST /api/procurements/:id/quotes/:seriesId/replies/:replyId/quote-links  { saveKey, version, note? } → the user's statement "this reply led to quote version N"
//   GET  /api/procurements/:id/clarification-drafts/:draftId/replies          replies of the series, links, per-question state
//   POST /api/procurements/:id/clarification-drafts/:draftId/replies          { saveKey, reply, sentRevision, note? } → link a reply to the draft
//   POST /api/procurements/:id/clarification-drafts/:draftId/answers          { key, link, question, expectedPrevious, status, excerpt?, buyerStatement?, statementKind?, note? }
//
// A reply is never a quote version: saving one changes no latest quote, draft basis, extraction or comparison.
// Answers carry the user's own reading; an excerpt must occur in the saved reply text. Nothing is sent.

import { CLARIFICATION_ANSWER_ID, CLARIFICATION_REPLY_ID, SUPPLIER_REPLY_ID } from "../../lib/replies.ts";
import { IDEMPOTENCY_KEY, QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { CLARIFICATION_DRAFT_ID } from "../clarification/store.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { readJsonBody } from "../procurement/http.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { ReplyService } from "./service.ts";

export type ReplySource = ReplyService | (() => ReplyService);
const LABEL = "Supplier reply API";
const resolve = (s: ReplySource) => (typeof s === "function" ? s() : s);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request, quote, draft or reply." });
const invalid = (message: string) => json(422, { ok: false, code: "VALIDATION_FAILED", message });
const keyReused = () => json(422, { ok: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This key was already used for different content. Nothing was saved." });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function note(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string" || [...v].length > 1000 || CONTROL.test(v)) return { ok: false };
  return { ok: true, value: v.trim() === "" ? null : v };
}

async function body(req: Request, max: number, allowed: string[]): Promise<{ ok: true; b: Record<string, unknown> } | { ok: false; response: Response }> {
  const read = await readJsonBody(req, max);
  if (!read.ok) return { ok: false, response: read.response };
  if (!isObject(read.value)) return { ok: false, response: invalid("Body must be a JSON object.") };
  const unknown = Object.keys(read.value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return { ok: false, response: invalid(`Unknown field(s): ${unknown.join(", ")}.`) };
  return { ok: true, b: read.value };
}

export async function handleSaveReply(req: Request, requestId: string, seriesId: string, source: ReplySource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId)) return notFound();
  const r = await body(req, 1024 * 1024, ["saveKey", "rawText", "receivedOn", "channelNote", "senderAsTyped", "correctsReplyId", "source"]);
  if (!r.ok) return r.response;
  const b = r.b;
  if (typeof b.saveKey !== "string" || !IDEMPOTENCY_KEY.test(b.saveKey)) return invalid("A save key (UUID) is required.");
  if (b.correctsReplyId !== undefined && b.correctsReplyId !== null && (typeof b.correctsReplyId !== "string" || !SUPPLIER_REPLY_ID.test(b.correctsReplyId))) return invalid("correctsReplyId must be a reply id.");
  const out = resolve(source).saveReply(who, requestId, seriesId, b, b.saveKey);
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(out.message);
    case "KEY_REUSED":
      return keyReused();
    case "REPLAYED":
      return json(200, { ok: true, code: "REPLAYED", message: "Already saved (repeat of the same request).", reply: out.reply });
    case "CREATED":
      return json(201, {
        ok: true,
        code: "CREATED",
        message: out.reply.sameTextAs.length > 0 ? "Reply saved as received. The same text was saved before for this quote (possible duplicate); both are kept separately." : "Reply saved as received. It is not a quote version and settles nothing.",
        possibleDuplicateOf: out.reply.sameTextAs,
        reply: out.reply,
      });
  }
}

export async function handleLinkQuote(req: Request, requestId: string, seriesId: string, replyId: string, source: ReplySource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId) || !QUOTE_SERIES_ID.test(seriesId) || !SUPPLIER_REPLY_ID.test(replyId)) return notFound();
  const r = await body(req, 8 * 1024, ["saveKey", "version", "note"]);
  if (!r.ok) return r.response;
  const b = r.b;
  if (typeof b.saveKey !== "string" || !IDEMPOTENCY_KEY.test(b.saveKey)) return invalid("A save key (UUID) is required.");
  if (typeof b.version !== "string" || !QUOTE_VERSION_ID.test(b.version)) return invalid("version must be a quote version id.");
  const n = note(b.note);
  if (!n.ok) return invalid("note must be text up to 1000 characters.");
  const out = resolve(source).linkQuote(who, requestId, replyId, b.version, n.value, b.saveKey);
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(out.message);
    case "KEY_REUSED":
      return keyReused();
    case "NOT_ELIGIBLE":
      return json(409, { ok: false, code: "NOT_ELIGIBLE", message: "The quote version must belong to the same quote as the reply. Nothing was linked." });
    case "EXISTING":
    case "REPLAYED":
      return json(200, { ok: true, code: out.status, message: "Already linked; nothing was changed.", reply: out.reply });
    case "CREATED":
      return json(201, { ok: true, code: "CREATED", message: "Recorded: this reply led to that quote version. Extract and compare that version before relying on its terms.", reply: out.reply });
  }
}

const idsOk = (requestId: string, draftId: string) => PROCUREMENT_ID.test(requestId) && CLARIFICATION_DRAFT_ID.test(draftId);

export async function handleGetReplies(req: Request, requestId: string, draftId: string, source: ReplySource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!idsOk(requestId, draftId)) return notFound();
  const view = resolve(source).view(who, requestId, draftId);
  return view ? json(200, { ok: true, ...view }) : notFound();
}

export async function handleLinkReply(req: Request, requestId: string, draftId: string, source: ReplySource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!idsOk(requestId, draftId)) return notFound();
  const r = await body(req, 8 * 1024, ["saveKey", "reply", "sentRevision", "note"]);
  if (!r.ok) return r.response;
  const b = r.b;
  if (typeof b.saveKey !== "string" || !IDEMPOTENCY_KEY.test(b.saveKey)) return invalid("A save key (UUID) is required.");
  if (typeof b.reply !== "string" || !SUPPLIER_REPLY_ID.test(b.reply)) return invalid("reply must be a supplier reply id; the server reads the reply text itself.");
  if (typeof b.sentRevision !== "number" || !Number.isSafeInteger(b.sentRevision) || b.sentRevision < 1) return invalid("sentRevision must be a draft revision number.");
  const n = note(b.note);
  if (!n.ok) return invalid("note must be text up to 1000 characters.");
  const out = resolve(source).linkToDraft(who, requestId, draftId, b.reply, b.sentRevision, n.value, b.saveKey);
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(out.message);
    case "KEY_REUSED":
      return keyReused();
    case "NOT_ELIGIBLE":
      return json(409, { ok: false, code: "NOT_ELIGIBLE", message: "The reply must belong to this draft's quote, and the sent revision must exist. Nothing was linked." });
    case "EXISTING":
      return json(200, { ok: true, code: "EXISTING", message: "This reply is already linked to this draft; nothing was changed.", link: out.link });
    case "REPLAYED":
      return json(200, { ok: true, code: "REPLAYED", message: "Already linked (repeat of the same request).", link: out.link });
    case "CREATED":
      return json(201, { ok: true, code: "CREATED", message: "Reply linked to this draft. No question is marked answered until you record it.", link: out.link });
  }
}

export async function handleAnswer(req: Request, requestId: string, draftId: string, source: ReplySource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!idsOk(requestId, draftId)) return notFound();
  const r = await body(req, 16 * 1024, ["key", "link", "question", "expectedPrevious", "status", "excerpt", "buyerStatement", "statementKind", "note"]);
  if (!r.ok) return r.response;
  const b = r.b;
  if (typeof b.key !== "string" || !IDEMPOTENCY_KEY.test(b.key)) return invalid("An idempotency key (UUID) is required.");
  if (typeof b.link !== "string" || !CLARIFICATION_REPLY_ID.test(b.link)) return invalid("link must be a draft ↔ reply link id.");
  if (typeof b.question !== "string" || b.question.length < 1 || b.question.length > 300) return invalid("question must be a question id of this draft.");
  if (b.expectedPrevious !== null && (typeof b.expectedPrevious !== "string" || !CLARIFICATION_ANSWER_ID.test(b.expectedPrevious))) return invalid("expectedPrevious must be the newest answer id of this question, or null.");
  const out = resolve(source).answer(who, requestId, draftId, b.link, b.question, b.expectedPrevious as string | null, b, b.key);
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "INVALID":
      return invalid(out.message);
    case "EXCERPT_NOT_IN_REPLY":
      return json(422, { ok: false, code: "EXCERPT_NOT_IN_REPLY", message: "The excerpt does not occur in the saved reply text (copy it exactly). Nothing was saved." });
    case "KEY_REUSED":
      return keyReused();
    case "CONFLICT":
      return json(409, { ok: false, code: "ANSWER_CONFLICT", message: "This question's answer was changed elsewhere after you opened it. Nothing was saved.", current: out.current });
    case "UNCHANGED":
      return json(200, { ok: true, code: "UNCHANGED", message: "No changes to save.", answer: out.answer, statementCheck: out.statementCheck });
    case "REPLAYED":
      return json(200, { ok: true, code: "REPLAYED", message: "Already saved (repeat of the same save).", answer: out.answer, statementCheck: out.statementCheck });
    case "SAVED":
      return json(200, { ok: true, code: "SAVED", message: "Saved. Nothing was sent to the supplier.", answer: out.answer, statementCheck: out.statementCheck });
  }
}
