// Supplier reply tracking (28 Oct, schema v12; 29 Oct additions, schema v13). Pure TypeScript, shared by the
// server and the browser.
//
// What these records mean — and do not mean:
// - A supplier reply is text the user pasted (or a test fixture), kept as received, per quote series, with its own
//   received date, channel and source. The sender is what the user typed; it is NOT verified. The same text saved
//   again under a different request key is a separate reply (it may have arrived twice); it is flagged as a
//   possible duplicate, never merged. A reply is not a quote version: it never becomes the latest quote, is never
//   extracted or compared, and changes no draft's basis.
// - If the supplier sent an updated quote, the user saves it as a quote version (Quotes page) and may record
//   explicitly that this reply led to that version. That link says nothing about whether the version was
//   extracted, compared or approved — the page shows those as unverified and approval must check them itself.
// - Four things stay separate: a reply was received; the buyer recorded a reading (answer / statement); the quote
//   needs updating; the deal is approved. The last one never happens in this phase.
// - A buyer statement is the user's own reviewed wording of what the reply says, classified by the user as
//   confirming the condition the saved quote already states, proposing a new condition, or unclear. Only a new
//   condition needs an updated quote; "unclear" (and older unclassified statements) needs manual review. No
//   statement is the supplier's agreement to that wording, an approved condition or a payment amount.
// - An answer records the basis it was made on: request revision, latest quote version, the draft revision sent,
//   the draft's extraction run (and base run), the newest finished run of the quote version and the reviews of the
//   draft's runs. Any change → "review again"; the history stays and nothing is carried over as current.
// - Q numbers belong to ONE draft. Nothing matches replies to questions by "Q3" automatically.

import { extractTokens, type GeneratedDraft } from "./clarification.ts";

export const REPLY_RULES = "reply-tracking-2026-10-29.1";

export const ANSWER_STATUSES = ["ANSWERED", "PARTLY_ANSWERED", "NOT_ANSWERED"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/** The buyer's classification of a statement. */
export const STATEMENT_KINDS = ["CONFIRMS_ORIGINAL", "PROPOSES_NEW", "UNCLEAR"] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export const REPLY_SOURCES = ["USER_PASTE", "TEST_FIXTURE", "MIGRATED_FROM_QUOTE_VERSION"] as const;
export type ReplySource = (typeof REPLY_SOURCES)[number];

export const REPLY_LIMITS = { rawText: 100_000, excerpt: 2000, statement: 500, note: 1000, channel: 200, sender: 200 } as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const SUPPLIER_REPLY_ID = new RegExp(`^sr_${UUID}$`);
export const CLARIFICATION_REPLY_ID = new RegExp(`^cr_${UUID}$`);
export const CLARIFICATION_ANSWER_ID = new RegExp(`^ca_${UUID}$`);

/** Item pairing (which quote line belongs to which request line) is never a commercial term. */
export const NON_COMMERCIAL_FIELDS: ReadonlySet<string> = new Set(["pairing"]);

/** Stable, readable number of a question: its place in the draft's generated (immutable) order, 1-based. Scoped to that draft. */
export function questionNumber(g: Pick<GeneratedDraft, "questions">, questionId: string): number | null {
  const i = g.questions.findIndex((q) => q.id === questionId);
  return i < 0 ? null : i + 1;
}

/** List number the question had in the copied message of a revision (the list counts only selected questions). */
export function copiedNumber(selected: readonly string[], questionId: string): number | null {
  const i = selected.indexOf(questionId);
  return i < 0 ? null : i + 1;
}

export interface UpdatedQuoteLink {
  id: string;
  versionNumber: number;
  linkedAt: string;
  /** Finished extraction runs of that version (0 = not extracted). Comparison and approval are not recorded here. */
  finishedRuns: number;
}

export interface SupplierReply {
  id: string;
  requestId: string;
  seriesId: string;
  rawText: string;
  rawTextSha256: string;
  source: ReplySource;
  receivedOn: string | null;
  channelNote: string | null;
  /** As typed by the user. Not a verified identity. */
  senderAsTyped: string | null;
  /** v11 rows only: the quote version the reply text was read from. */
  fromQuoteVersion: { id: string; versionNumber: number } | null;
  correctsReplyId: string | null;
  /** Other replies of the same series with exactly the same text (possible duplicates; kept separately). */
  sameTextAs: string[];
  /** Quote versions the user said this reply led to (explicit links), oldest first. */
  updatedQuotes: UpdatedQuoteLink[];
  /** Drafts this reply is linked to (empty = not assigned to any draft). */
  linkedDraftIds: string[];
  createdAt: string;
}

/** A supplier reply linked to one draft. */
export interface DraftReplyLink {
  id: string;
  draftId: string;
  sentRevision: number;
  /** Ordered question ids selected in the sent revision (copied list number n = n-th id). */
  sentSelected: string[];
  reply: SupplierReply;
  note: string | null;
  createdAt: string;
}

/** What an answer was recorded on (rules "basis-2", 29 Oct). */
export interface AnswerBasis {
  rules: "basis-2";
  requestRevision: number | null;
  latestQuoteVersionNumber: number;
  sentRevision: number;
  runId: string;
  baseRunId: string | null;
  /** Newest finished extraction run of the draft's quote version. */
  newestRunId: string | null;
  /** Reviews of the draft's run (and base run): count + newest review id. */
  reviews: { runId: string; count: number; lastId: string | null }[];
}

/** v12 answers stored only these two fields; v11 answers stored nothing. */
export type StoredBasis = AnswerBasis | { requestRevision: number | null; latestQuoteVersionNumber: number } | null;

export type BasisChange = "BASIS_NOT_RECORDED" | "BASIS_INCOMPLETE" | "REQUEST_REVISED" | "NEWER_QUOTE_VERSION" | "SENT_REVISION_DIFFERS" | "NEWER_RUN" | "REVIEWS_CHANGED";

export interface StoredAnswer {
  id: string;
  draftId: string;
  /** The draft ↔ reply link (cr_…). */
  replyId: string;
  questionId: string;
  status: AnswerStatus;
  excerpt: string | null;
  buyerStatement: string | null;
  /** null for a statement recorded before classification existed (v11 / v12) → manual review. */
  statementKind: StatementKind | null;
  note: string | null;
  basis: StoredBasis;
  supersedesId: string | null;
  createdAt: string;
}

export interface AnswerInput {
  status: AnswerStatus;
  excerpt: string | null;
  buyerStatement: string | null;
  statementKind: StatementKind | null;
  note: string | null;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const len = (s: string) => [...s].length;

type TextCheck = { ok: true; value: string | null } | { ok: false; message: string };
export function optionalText(x: unknown, name: string, max: number, keepNewlines = true): TextCheck {
  if (x === undefined || x === null) return { ok: true, value: null };
  if (typeof x !== "string") return { ok: false, message: `${name} must be text.` };
  if (x.trim() === "") return { ok: true, value: null };
  if (len(x) > max) return { ok: false, message: `${name} is longer than ${max} characters.` };
  if (CONTROL.test(x) || (!keepNewlines && /[\r\n]/.test(x))) return { ok: false, message: `${name} contains control characters.` };
  return { ok: true, value: x };
}

/** Shape and limits of one answer. The excerpt-in-reply rule is checked by the store (and a DB trigger). */
export function validateAnswer(v: { status: unknown; excerpt?: unknown; buyerStatement?: unknown; statementKind?: unknown; note?: unknown }): { ok: true; value: AnswerInput } | { ok: false; message: string } {
  if (typeof v.status !== "string" || !(ANSWER_STATUSES as readonly string[]).includes(v.status)) return { ok: false, message: `status must be one of ${ANSWER_STATUSES.join(", ")}.` };
  const status = v.status as AnswerStatus;
  const excerpt = optionalText(v.excerpt, "excerpt", REPLY_LIMITS.excerpt);
  if (!excerpt.ok) return excerpt;
  const statement = optionalText(v.buyerStatement, "buyerStatement", REPLY_LIMITS.statement);
  if (!statement.ok) return statement;
  const note = optionalText(v.note, "note", REPLY_LIMITS.note);
  if (!note.ok) return note;
  const kind = v.statementKind === undefined || v.statementKind === null ? null : v.statementKind;
  if (kind !== null && (typeof kind !== "string" || !(STATEMENT_KINDS as readonly string[]).includes(kind))) return { ok: false, message: `statementKind must be one of ${STATEMENT_KINDS.join(", ")}.` };
  if (status === "NOT_ANSWERED" && excerpt.value !== null) return { ok: false, message: "A question marked not answered has no excerpt." };
  if (status !== "NOT_ANSWERED" && excerpt.value === null) return { ok: false, message: "Copy the part of the supplier's reply that answers this question (excerpt)." };
  if (statement.value !== null && status !== "ANSWERED") return { ok: false, message: "A buyer statement can be recorded only for a question marked answered." };
  if ((statement.value === null) !== (kind === null)) return { ok: false, message: "A buyer statement needs a classification (confirms the quoted condition / proposes a new condition / unclear), and a classification needs a statement." };
  return { ok: true, value: { status, excerpt: excerpt.value, buyerStatement: statement.value, statementKind: kind as StatementKind | null, note: note.value } };
}

export const sameAnswer = (a: AnswerInput, b: AnswerInput) =>
  a.status === b.status && a.excerpt === b.excerpt && a.buyerStatement === b.buyerStatement && a.statementKind === b.statementKind && a.note === b.note;

export interface StatementCheck {
  /** Values (numbers with currency / unit, dates, trade-term codes …) of the statement that are not in the excerpt. */
  notInExcerpt: string[];
  /** Parts of the statement the number reader cannot read (ambiguous formats, numbers in words). */
  unreadable: string[];
}

/**
 * Deterministic look at a buyer statement against its excerpt, with the same reader as the bilingual check.
 * A finding means "needs your review". An empty result only says the values also occur in the supplier's
 * words — not that the supplier agreed to the statement; meaning is not compared.
 */
export function checkStatement(statement: string, excerpt: string): StatementCheck {
  const t = extractTokens(statement);
  const e = new Set(extractTokens(excerpt).tokens.map((x) => x.key));
  return { notInExcerpt: [...new Set(t.tokens.filter((x) => !e.has(x.key)).map((x) => x.label))], unreadable: t.unreadable };
}

export type QuestionState = "OPEN" | "NOT_ANSWERED" | "PARTLY_ANSWERED" | "ANSWERED" | "STATEMENT_RECORDED";

/** State of one question = its newest answer (any linked reply of the draft); no answer = still open. */
export function questionState(latest: StoredAnswer | null): QuestionState {
  if (!latest) return "OPEN";
  if (latest.status === "ANSWERED") return latest.buyerStatement !== null ? "STATEMENT_RECORDED" : "ANSWERED";
  return latest.status;
}

/** What changed between the basis an answer was recorded on and now. Empty = still current. */
export function basisChanges(stored: StoredBasis, now: AnswerBasis): BasisChange[] {
  if (stored === null) return ["BASIS_NOT_RECORDED"];
  if (!("rules" in stored)) return ["BASIS_INCOMPLETE"];
  const out: BasisChange[] = [];
  if (stored.requestRevision !== now.requestRevision) out.push("REQUEST_REVISED");
  if (stored.latestQuoteVersionNumber !== now.latestQuoteVersionNumber) out.push("NEWER_QUOTE_VERSION");
  if (stored.sentRevision !== now.sentRevision) out.push("SENT_REVISION_DIFFERS");
  if (stored.runId !== now.runId || stored.baseRunId !== now.baseRunId || stored.newestRunId !== now.newestRunId) out.push("NEWER_RUN");
  if (JSON.stringify(stored.reviews) !== JSON.stringify(now.reviews)) out.push("REVIEWS_CHANGED");
  return out;
}

/** What the quote needs because of the newest reading of a question. */
export type QuoteUpdate = "NONE" | "UPDATED_QUOTE_NEEDED" | "MANUAL_REVIEW";

export function quoteUpdateFor(latest: StoredAnswer | null, field: string): QuoteUpdate {
  if (!latest || latest.buyerStatement === null) return "NONE";
  if (latest.statementKind === null || latest.statementKind === "UNCLEAR") return "MANUAL_REVIEW";
  if (latest.statementKind === "PROPOSES_NEW") return NON_COMMERCIAL_FIELDS.has(field) ? "MANUAL_REVIEW" : "UPDATED_QUOTE_NEEDED";
  return "NONE";
}

/**
 * Readings of one question from DIFFERENT supplier replies that disagree (status, statement or its classification).
 * The newest reading is still shown first; the disagreement is flagged, never resolved automatically.
 */
export function contradictions(history: StoredAnswer[], supplierReplyOf: (linkId: string) => string): StoredAnswer[] {
  const newestPerReply = new Map<string, StoredAnswer>();
  for (const a of history) newestPerReply.set(supplierReplyOf(a.replyId), a); // history is oldest first
  const readings = [...newestPerReply.values()];
  const key = (a: StoredAnswer) => `${a.status}|${a.buyerStatement ?? ""}|${a.statementKind ?? ""}`;
  return new Set(readings.map(key)).size > 1 ? readings : [];
}
