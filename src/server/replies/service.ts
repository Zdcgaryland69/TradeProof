// Supplier reply tracking (28 Oct, schema v12; 29 Oct, schema v13). The browser sends the reply text the user
// pasted (kept as received, sender not verified), ids, and the user's own reading of a reply (status, excerpt,
// buyer statement + its classification, note). Everything else — which series / draft a reply may belong to, the
// draft's questions, what was selected in the sent revision, the basis an answer is recorded on — is read on the
// server. Ownership goes through policy.ts like the drafts. No model, no translation service, no PayPal call;
// nothing is sent; no quote version, extraction, comparison, draft, approval or payment is created or changed.

import type { DraftQuestion, GeneratedDraft } from "../../lib/clarification.ts";
import {
  basisChanges,
  checkStatement,
  contradictions,
  copiedNumber,
  optionalText,
  questionNumber,
  questionState,
  quoteUpdateFor,
  REPLY_LIMITS,
  validateAnswer,
  type AnswerBasis,
  type BasisChange,
  type DraftReplyLink,
  type QuestionState,
  type QuoteUpdate,
  type StatementCheck,
  type StatementKind,
  type StoredAnswer,
  type SupplierReply,
} from "../../lib/replies.ts";
import { canReadRequest, canWriteRequest, type Principal } from "../access/policy.ts";
import type { ClarificationStore, StoredDraft } from "../clarification/store.ts";
import type { ReplyStore } from "./store.ts";

export interface QuestionReplyState {
  questionId: string;
  /** Q number, scoped to this draft. */
  number: number;
  field: string;
  itemName: string | null;
  state: QuestionState;
  latest: StoredAnswer | null;
  /** The four separate facts: a reply is linked to the draft; the buyer recorded a reading; the quote update; approval. */
  replyReceived: boolean;
  quoteUpdate: QuoteUpdate;
  /** Always false in this phase: approval is not built, and no reading approves anything. */
  approved: false;
  /** What changed since the newest answer was recorded (empty = recorded on the current basis). */
  basisChanges: BasisChange[];
  basisCurrent: boolean;
  /** Newest readings from different supplier replies that disagree (empty = none). */
  contradictions: StoredAnswer[];
  /** List number in the copied message of each linked reply's sent revision (null = not in that message). */
  copiedIn: { linkId: string; number: number | null }[];
  statementCheck: StatementCheck | null;
  history: StoredAnswer[];
}

export interface ReplyView {
  draftId: string;
  seriesId: string;
  askedVersionNumber: number;
  latestRevision: number;
  /** Every reply of the draft's quote series (linked to this draft or not), oldest first. */
  seriesReplies: SupplierReply[];
  links: DraftReplyLink[];
  versions: { id: string; versionNumber: number; contentKind: string; savedAt: string }[];
  questions: QuestionReplyState[];
}

/** A buyer statement as later steps may read it. Never an approved condition or a payment amount. */
export interface BuyerStatement {
  draftId: string;
  questionId: string;
  number: number;
  field: string;
  requestItemId: string | null;
  itemName: string | null;
  statement: string;
  statementKind: StatementKind | null;
  quoteUpdate: QuoteUpdate;
  excerpt: string;
  answerId: string;
  supplierReplyId: string;
  basisChanges: BasisChange[];
  contradicted: boolean;
  /** Always false: a statement is the buyer's review note, not a term. Terms come only from a compared quote version. */
  usableAsApprovedTerm: false;
  /** Always false: no statement is ever a payment amount. */
  usableAsPaymentAmount: false;
  recordedAt: string;
}

/**
 * What TradeProof can say about a quote version linked to a reply as "the updated quote". For the approval step
 * (29–30 Oct) to check on the server: a link alone proves nothing; comparison and approval are not recorded here.
 */
export interface UpdatedQuoteStatus {
  versionId: string;
  linkedFromReplies: string[];
  finishedRuns: number;
  comparisonRecorded: false;
  approved: false;
}

type Fail = { status: "NOT_FOUND" } | { status: "INVALID"; message: string } | { status: "KEY_REUSED" };
export type SaveReplyResult = Fail | { status: "CREATED" | "REPLAYED"; reply: SupplierReply };
export type LinkResult = Fail | { status: "NOT_ELIGIBLE" } | { status: "CREATED" | "EXISTING" | "REPLAYED"; link: DraftReplyLink };
export type QuoteLinkResult = Fail | { status: "NOT_ELIGIBLE" } | { status: "CREATED" | "EXISTING" | "REPLAYED"; reply: SupplierReply };
export type AnswerResult =
  | Fail
  | { status: "EXCERPT_NOT_IN_REPLY" }
  | { status: "CONFLICT"; current: StoredAnswer | null }
  | { status: "SAVED" | "UNCHANGED" | "REPLAYED"; answer: StoredAnswer; statementCheck: StatementCheck | null };

const statementCheckOf = (a: StoredAnswer | null) => (a?.buyerStatement && a.excerpt ? checkStatement(a.buyerStatement, a.excerpt) : null);
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class ReplyService {
  private readonly replies: ReplyStore;
  private readonly drafts: ClarificationStore;

  constructor(replies: ReplyStore, drafts: ClarificationStore) {
    this.replies = replies;
    this.drafts = drafts;
  }

  private draftOf(requestId: string, draftId: string): StoredDraft | null {
    const d = this.drafts.get(draftId);
    return d && d.requestId === requestId ? d : null;
  }

  /** The basis an answer through `link` would be recorded on now. */
  private basisOf(d: StoredDraft, link: DraftReplyLink): AnswerBasis {
    return {
      rules: "basis-2",
      requestRevision: this.replies.requestRevision(d.requestId),
      latestQuoteVersionNumber: this.replies.latestVersionNumber(d.seriesId),
      sentRevision: link.sentRevision,
      runId: d.extractionId,
      baseRunId: d.baseExtractionId,
      newestRunId: this.replies.newestFinishedRun(d.versionId),
      reviews: [this.drafts.reviewState(d.extractionId), ...(d.baseExtractionId ? [this.drafts.reviewState(d.baseExtractionId)] : [])],
    };
  }

  private questionStates(d: StoredDraft, links: DraftReplyLink[], answers: StoredAnswer[]): QuestionReplyState[] {
    const g: GeneratedDraft = d.generated;
    const linkOf = new Map(links.map((l) => [l.id, l] as const));
    return g.questions.map((q: DraftQuestion) => {
      const history = answers.filter((a) => a.questionId === q.id);
      const superseded = new Set(history.map((a) => a.supersedesId).filter((x): x is string => x !== null));
      const latest = history.find((a) => !superseded.has(a.id)) ?? null;
      const latestLink = latest ? linkOf.get(latest.replyId) : undefined;
      const changes = latest && latestLink ? basisChanges(latest.basis, this.basisOf(d, latestLink)) : [];
      return {
        questionId: q.id,
        number: questionNumber(g, q.id)!,
        field: q.field,
        itemName: q.itemName,
        state: questionState(latest),
        latest,
        replyReceived: links.length > 0,
        quoteUpdate: quoteUpdateFor(latest, q.field),
        approved: false,
        basisChanges: changes,
        basisCurrent: changes.length === 0,
        contradictions: contradictions(history, (linkId) => linkOf.get(linkId)?.reply.id ?? linkId),
        copiedIn: links.map((l) => ({ linkId: l.id, number: copiedNumber(l.sentSelected, q.id) })),
        statementCheck: statementCheckOf(latest),
        history,
      };
    });
  }

  /** Reads only. A draft of another request is null (same answer as an unknown id). */
  view(principal: Principal, requestId: string, draftId: string): ReplyView | null {
    if (!canReadRequest(principal, requestId)) return null;
    const d = this.draftOf(requestId, draftId);
    if (!d) return null;
    const links = this.replies.links(draftId);
    return {
      draftId,
      seriesId: d.seriesId,
      askedVersionNumber: d.source.versionNumber,
      latestRevision: this.drafts.latest(draftId)!.revision,
      seriesReplies: this.replies.seriesReplies(d.seriesId),
      links,
      versions: this.replies.seriesVersions(d.seriesId),
      questions: this.questionStates(d, links, this.replies.answers(draftId)),
    };
  }

  /** Saves the supplier's reply text for a quote series. Not a quote version; changes no draft basis. */
  saveReply(principal: Principal, requestId: string, seriesId: string, body: Record<string, unknown>, saveKey: string): SaveReplyResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const raw = body.rawText;
    if (typeof raw !== "string" || raw.trim() === "") return { status: "INVALID", message: "Paste the supplier's reply text." };
    const text = optionalText(raw, "rawText", REPLY_LIMITS.rawText);
    if (!text.ok) return { status: "INVALID", message: text.message };
    const channel = optionalText(body.channelNote, "channelNote", REPLY_LIMITS.channel, false);
    if (!channel.ok) return { status: "INVALID", message: channel.message };
    const sender = optionalText(body.senderAsTyped, "senderAsTyped", REPLY_LIMITS.sender, false);
    if (!sender.ok) return { status: "INVALID", message: sender.message };
    const receivedOn = body.receivedOn === undefined || body.receivedOn === null || body.receivedOn === "" ? null : body.receivedOn;
    if (receivedOn !== null && (typeof receivedOn !== "string" || !DATE.test(receivedOn))) return { status: "INVALID", message: "receivedOn must be a date (YYYY-MM-DD)." };
    const source = body.source === undefined ? "USER_PASTE" : body.source;
    if (source !== "USER_PASTE" && source !== "TEST_FIXTURE") return { status: "INVALID", message: "source must be USER_PASTE or TEST_FIXTURE." };
    const corrects = body.correctsReplyId === undefined || body.correctsReplyId === null ? null : body.correctsReplyId;
    if (corrects !== null && typeof corrects !== "string") return { status: "INVALID", message: "correctsReplyId must be a reply id." };
    return this.replies.saveReply(requestId, seriesId, { rawText: raw, source, receivedOn: receivedOn as string | null, channelNote: channel.value, senderAsTyped: sender.value, correctsReplyId: corrects as string | null }, saveKey);
  }

  linkToDraft(principal: Principal, requestId: string, draftId: string, replyId: string, sentRevision: number, note: string | null, saveKey: string): LinkResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    if (!this.draftOf(requestId, draftId)) return { status: "NOT_FOUND" };
    const reply = this.replies.supplierReply(replyId);
    if (!reply || reply.requestId !== requestId) return { status: "NOT_FOUND" };
    return this.replies.linkToDraft(draftId, replyId, sentRevision, note, saveKey);
  }

  linkQuote(principal: Principal, requestId: string, replyId: string, versionId: string, note: string | null, saveKey: string): QuoteLinkResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const reply = this.replies.supplierReply(replyId);
    if (!reply || reply.requestId !== requestId) return { status: "NOT_FOUND" };
    return this.replies.linkQuote(replyId, versionId, note, saveKey);
  }

  answer(principal: Principal, requestId: string, draftId: string, linkId: string, questionId: string, expectedPrevious: string | null, body: Record<string, unknown>, key: string): AnswerResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const d = this.draftOf(requestId, draftId);
    if (!d) return { status: "NOT_FOUND" };
    const link = this.replies.link(linkId);
    if (!link || link.draftId !== draftId) return { status: "NOT_FOUND" };
    if (questionNumber(d.generated, questionId) === null) return { status: "INVALID", message: "Unknown question for this draft." };
    const valid = validateAnswer({ status: body.status, excerpt: body.excerpt, buyerStatement: body.buyerStatement, statementKind: body.statementKind, note: body.note });
    if (!valid.ok) return { status: "INVALID", message: valid.message };
    const out = this.replies.answer(link, questionId, expectedPrevious, valid.value, this.basisOf(d, link), key);
    switch (out.status) {
      case "SAVED":
      case "UNCHANGED":
      case "REPLAYED":
        return { status: out.status, answer: out.answer, statementCheck: statementCheckOf(out.answer) };
      default:
        return out;
    }
  }

  /**
   * Buyer statements (newest reading per question) over all drafts of the request, with their flags. For later
   * steps to read explicitly. Never an approved term or a payment amount.
   */
  buyerStatements(principal: Principal, requestId: string): BuyerStatement[] | null {
    if (!canReadRequest(principal, requestId)) return null;
    const out: BuyerStatement[] = [];
    for (const draftId of this.replies.draftsWithReplies(requestId)) {
      const d = this.draftOf(requestId, draftId)!;
      const links = this.replies.links(draftId);
      const byLink = new Map(links.map((l) => [l.id, l] as const));
      for (const s of this.questionStates(d, links, this.replies.answers(draftId))) {
        if (s.state !== "STATEMENT_RECORDED" || !s.latest) continue;
        const q = d.generated.questions.find((x) => x.id === s.questionId)!;
        out.push({
          draftId,
          questionId: s.questionId,
          number: s.number,
          field: q.field,
          requestItemId: q.requestItemId,
          itemName: q.itemName,
          statement: s.latest.buyerStatement!,
          statementKind: s.latest.statementKind,
          quoteUpdate: s.quoteUpdate,
          excerpt: s.latest.excerpt!,
          answerId: s.latest.id,
          supplierReplyId: byLink.get(s.latest.replyId)!.reply.id,
          basisChanges: s.basisChanges,
          contradicted: s.contradictions.length > 0,
          usableAsApprovedTerm: false,
          usableAsPaymentAmount: false,
          recordedAt: s.latest.createdAt,
        });
      }
    }
    return out;
  }

  /** What is (not) known about a quote version linked as an "updated quote" — for the approval step to check on the server. */
  updatedQuoteStatus(principal: Principal, requestId: string, seriesId: string, versionId: string): UpdatedQuoteStatus | null {
    if (!canReadRequest(principal, requestId)) return null;
    const replies = this.replies.seriesReplies(seriesId).filter((r) => r.requestId === requestId && r.updatedQuotes.some((u) => u.id === versionId));
    const link = replies[0]?.updatedQuotes.find((u) => u.id === versionId);
    return { versionId, linkedFromReplies: replies.map((r) => r.id), finishedRuns: link?.finishedRuns ?? 0, comparisonRecorded: false, approved: false };
  }
}
