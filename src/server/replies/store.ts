// Storage for supplier reply tracking (schema v12; statement classification v13). Same local SQLite file. Supplier replies, reply → quote
// links, draft ↔ reply links and answers are append-only (triggers refuse UPDATE / DELETE). Nothing here writes
// to requests, quotes / quote versions, extraction runs, reviews, drafts, the budget ledger or payments.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DraftContent } from "../../lib/clarification.ts";
import { sameAnswer, type AnswerBasis, type AnswerInput, type DraftReplyLink, type ReplySource, type StatementKind, type StoredAnswer, type StoredBasis, type SupplierReply } from "../../lib/replies.ts";
import { sha256 } from "../clarification/store.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export interface NewReply {
  rawText: string;
  source: "USER_PASTE" | "TEST_FIXTURE";
  receivedOn: string | null;
  channelNote: string | null;
  senderAsTyped: string | null;
  correctsReplyId: string | null;
}

export type SaveReplyOutcome =
  | { status: "CREATED" | "REPLAYED"; reply: SupplierReply }
  | { status: "NOT_FOUND" }
  | { status: "KEY_REUSED" };

export type LinkOutcome =
  | { status: "CREATED" | "EXISTING" | "REPLAYED"; link: DraftReplyLink }
  | { status: "NOT_ELIGIBLE" }
  | { status: "KEY_REUSED" };

export type QuoteLinkOutcome = { status: "CREATED" | "EXISTING" | "REPLAYED"; reply: SupplierReply } | { status: "NOT_ELIGIBLE" } | { status: "KEY_REUSED" };

export type AnswerOutcome =
  | { status: "SAVED" | "UNCHANGED" | "REPLAYED"; answer: StoredAnswer }
  | { status: "CONFLICT"; current: StoredAnswer | null }
  | { status: "EXCERPT_NOT_IN_REPLY" }
  | { status: "KEY_REUSED" };

export class ReplyStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(filePath: string, options: OpenOptions & { now?: () => Date } = {}) {
    this.db = openDatabase(filePath, options);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ------------------------------------------------------------ supplier replies (per quote series)

  private toReply(row: Row): SupplierReply {
    const id = String(row.id);
    const updatedQuotes = (
      this.db
        .prepare(
          `SELECT v.id, v.version_number, l.created_at,
                  (SELECT count(*) FROM quote_extraction_runs x WHERE x.version_id = v.id AND x.status IN ('SUCCEEDED', 'INCOMPLETE')) AS finished
             FROM supplier_reply_quote_links l JOIN quote_versions v ON v.id = l.quote_version_id WHERE l.reply_id = ? ORDER BY l.created_at, l.rowid`,
        )
        .all(id) as Row[]
    ).map((r) => ({ id: String(r.id), versionNumber: Number(r.version_number), linkedAt: String(r.created_at), finishedRuns: Number(r.finished) }));
    const sameTextAs = (
      this.db.prepare("SELECT id FROM supplier_replies WHERE series_id = ? AND raw_text_sha256 = ? AND id <> ? ORDER BY created_at, rowid").all(String(row.series_id), String(row.raw_text_sha256), id) as Row[]
    ).map((r) => String(r.id));
    const from = row.from_quote_version_id === null ? null : (this.db.prepare("SELECT id, version_number FROM quote_versions WHERE id = ?").get(String(row.from_quote_version_id)) as Row);
    return {
      id,
      requestId: String(row.request_id),
      seriesId: String(row.series_id),
      rawText: String(row.raw_text),
      rawTextSha256: String(row.raw_text_sha256),
      source: String(row.source) as ReplySource,
      receivedOn: str(row.received_on),
      channelNote: str(row.channel_note),
      senderAsTyped: str(row.sender_as_typed),
      fromQuoteVersion: from ? { id: String(from.id), versionNumber: Number(from.version_number) } : null,
      correctsReplyId: str(row.corrects_reply_id),
      sameTextAs,
      updatedQuotes,
      linkedDraftIds: (this.db.prepare("SELECT draft_id FROM clarification_replies WHERE supplier_reply_id = ? ORDER BY created_at, rowid").all(id) as Row[]).map((r) => String(r.draft_id)),
      createdAt: String(row.created_at),
    };
  }

  supplierReply(id: string): SupplierReply | null {
    const row = this.db.prepare("SELECT * FROM supplier_replies WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toReply(row) : null;
  }

  /** Replies of one quote series (supplier), oldest first — linked to a draft or not. */
  seriesReplies(seriesId: string): SupplierReply[] {
    return (this.db.prepare("SELECT * FROM supplier_replies WHERE series_id = ? ORDER BY created_at, rowid").all(seriesId) as Row[]).map((r) => this.toReply(r));
  }

  /**
   * Saves a reply text for a series. The same save key with the same payload replays (the original row); the
   * same key with another payload is refused. A different key saves a new reply even when the text is identical
   * (it may have been received again, at another time or through another channel): it keeps its own received date,
   * channel and source and is flagged through `sameTextAs`, never merged.
   */
  saveReply(requestId: string, seriesId: string, input: NewReply, saveKey: string): SaveReplyOutcome {
    const hash = sha256(input.rawText);
    const fingerprint = JSON.stringify([requestId, seriesId, hash, input.source, input.receivedOn, input.channelNote, input.senderAsTyped, input.correctsReplyId]);
    return this.transaction((): SaveReplyOutcome => {
      const keyed = this.db.prepare("SELECT * FROM supplier_replies WHERE save_key = ?").get(saveKey) as Row | undefined;
      if (keyed) {
        const same = JSON.stringify([keyed.request_id, keyed.series_id, keyed.raw_text_sha256, keyed.source, keyed.received_on, keyed.channel_note, keyed.sender_as_typed, keyed.corrects_reply_id]) === fingerprint;
        return same ? { status: "REPLAYED", reply: this.toReply(keyed) } : { status: "KEY_REUSED" };
      }
      const series = this.db.prepare("SELECT 1 FROM quote_series WHERE id = ? AND request_id = ?").get(seriesId, requestId);
      if (!series) return { status: "NOT_FOUND" };
      if (input.correctsReplyId !== null) {
        const corrected = this.db.prepare("SELECT series_id FROM supplier_replies WHERE id = ?").get(input.correctsReplyId) as Row | undefined;
        if (!corrected || String(corrected.series_id) !== seriesId) return { status: "NOT_FOUND" };
      }
      const id = `sr_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO supplier_replies (id, request_id, series_id, raw_text, raw_text_sha256, source, received_on, channel_note, sender_as_typed, from_quote_version_id, corrects_reply_id, save_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(id, requestId, seriesId, input.rawText, hash, input.source, input.receivedOn, input.channelNote, input.senderAsTyped, input.correctsReplyId, saveKey, this.now().toISOString());
      return { status: "CREATED", reply: this.supplierReply(id)! };
    });
  }

  /** The user's statement that this reply led to an updated quote version (same series). Append-only. */
  linkQuote(replyId: string, versionId: string, note: string | null, saveKey: string): QuoteLinkOutcome {
    return this.transaction((): QuoteLinkOutcome => {
      const keyed = this.db.prepare("SELECT * FROM supplier_reply_quote_links WHERE save_key = ?").get(saveKey) as Row | undefined;
      if (keyed) return String(keyed.reply_id) === replyId && String(keyed.quote_version_id) === versionId && str(keyed.note) === note ? { status: "REPLAYED", reply: this.supplierReply(replyId)! } : { status: "KEY_REUSED" };
      const reply = this.db.prepare("SELECT series_id FROM supplier_replies WHERE id = ?").get(replyId) as Row | undefined;
      const version = this.db.prepare("SELECT series_id FROM quote_versions WHERE id = ?").get(versionId) as Row | undefined;
      if (!reply || !version || String(reply.series_id) !== String(version.series_id)) return { status: "NOT_ELIGIBLE" };
      if (this.db.prepare("SELECT 1 FROM supplier_reply_quote_links WHERE reply_id = ? AND quote_version_id = ?").get(replyId, versionId)) return { status: "EXISTING", reply: this.supplierReply(replyId)! };
      this.db
        .prepare("INSERT INTO supplier_reply_quote_links (id, reply_id, quote_version_id, note, save_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`srq_${randomUUID()}`, replyId, versionId, note, saveKey, this.now().toISOString());
      return { status: "CREATED", reply: this.supplierReply(replyId)! };
    });
  }

  /** Quote versions of a series (for the explicit "updated quote" link), oldest first. */
  seriesVersions(seriesId: string): { id: string; versionNumber: number; contentKind: string; savedAt: string }[] {
    return (this.db.prepare("SELECT id, version_number, content_kind, saved_at FROM quote_versions WHERE series_id = ? ORDER BY version_number").all(seriesId) as Row[]).map((r) => ({
      id: String(r.id),
      versionNumber: Number(r.version_number),
      contentKind: String(r.content_kind),
      savedAt: String(r.saved_at),
    }));
  }

  /** Current revision of the request (null if unknown). */
  requestRevision(requestId: string): number | null {
    const row = this.db.prepare("SELECT revision FROM procurement_requests WHERE id = ?").get(requestId) as Row | undefined;
    return row ? Number(row.revision) : null;
  }

  /** Newest finished (SUCCEEDED / INCOMPLETE) extraction run of a quote version, or null. */
  newestFinishedRun(versionId: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM quote_extraction_runs WHERE version_id = ? AND status IN ('SUCCEEDED', 'INCOMPLETE') ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(versionId) as Row | undefined;
    return row ? String(row.id) : null;
  }

  latestVersionNumber(seriesId: string): number {
    return Number((this.db.prepare("SELECT coalesce(max(version_number), 0) AS n FROM quote_versions WHERE series_id = ?").get(seriesId) as Row).n);
  }

  // ------------------------------------------------------------ draft ↔ reply links

  private static readonly LINK_SELECT = `
    SELECT l.*, (SELECT content_json FROM clarification_draft_revisions WHERE draft_id = l.draft_id AND revision = l.sent_revision) AS sent_content
      FROM clarification_replies l`;

  private toLink(row: Row): DraftReplyLink {
    return {
      id: String(row.id),
      draftId: String(row.draft_id),
      sentRevision: Number(row.sent_revision),
      sentSelected: (JSON.parse(String(row.sent_content)) as DraftContent).selected,
      reply: this.supplierReply(String(row.supplier_reply_id))!,
      note: str(row.note),
      createdAt: String(row.created_at),
    };
  }

  links(draftId: string): DraftReplyLink[] {
    return (this.db.prepare(`${ReplyStore.LINK_SELECT} WHERE l.draft_id = ? ORDER BY l.created_at, l.rowid`).all(draftId) as Row[]).map((r) => this.toLink(r));
  }

  link(linkId: string): DraftReplyLink | null {
    const row = this.db.prepare(`${ReplyStore.LINK_SELECT} WHERE l.id = ?`).get(linkId) as Row | undefined;
    return row ? this.toLink(row) : null;
  }

  /** Links a reply of the draft's series to the draft. Same draft + reply → EXISTING; key replay / reuse as usual. */
  linkToDraft(draftId: string, replyId: string, sentRevision: number, note: string | null, saveKey: string): LinkOutcome {
    return this.transaction((): LinkOutcome => {
      const keyed = this.db.prepare(`${ReplyStore.LINK_SELECT} WHERE l.save_key = ?`).get(saveKey) as Row | undefined;
      if (keyed) {
        const same = String(keyed.draft_id) === draftId && String(keyed.supplier_reply_id) === replyId && Number(keyed.sent_revision) === sentRevision && str(keyed.note) === note;
        return same ? { status: "REPLAYED", link: this.toLink(keyed) } : { status: "KEY_REUSED" };
      }
      const existing = this.db.prepare(`${ReplyStore.LINK_SELECT} WHERE l.draft_id = ? AND l.supplier_reply_id = ?`).get(draftId, replyId) as Row | undefined;
      if (existing) return { status: "EXISTING", link: this.toLink(existing) };
      const sameSeries = this.db
        .prepare("SELECT 1 FROM clarification_drafts d JOIN supplier_replies s ON s.series_id = d.series_id WHERE d.id = ? AND s.id = ?")
        .get(draftId, replyId);
      const revisionExists = this.db.prepare("SELECT 1 FROM clarification_draft_revisions WHERE draft_id = ? AND revision = ?").get(draftId, sentRevision);
      if (!sameSeries || !revisionExists) return { status: "NOT_ELIGIBLE" };
      const id = `cr_${randomUUID()}`;
      this.db
        .prepare("INSERT INTO clarification_replies (id, draft_id, supplier_reply_id, sent_revision, note, save_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, draftId, replyId, sentRevision, note, saveKey, this.now().toISOString());
      return { status: "CREATED", link: this.link(id)! };
    });
  }

  // ------------------------------------------------------------ answers

  private toAnswer(row: Row): StoredAnswer {
    return {
      id: String(row.id),
      draftId: String(row.draft_id),
      replyId: String(row.reply_id),
      questionId: String(row.question_id),
      status: String(row.status) as StoredAnswer["status"],
      excerpt: str(row.excerpt),
      buyerStatement: str(row.buyer_statement),
      statementKind: (str(row.statement_kind) as StatementKind | null) ?? null,
      note: str(row.note),
      basis: row.basis_json === null ? null : (JSON.parse(String(row.basis_json)) as StoredBasis),
      supersedesId: str(row.supersedes_id),
      createdAt: String(row.created_at),
    };
  }

  /** Every answer of a draft, oldest first. */
  answers(draftId: string): StoredAnswer[] {
    return (this.db.prepare("SELECT * FROM clarification_answers WHERE draft_id = ? ORDER BY created_at, rowid").all(draftId) as Row[]).map((r) => this.toAnswer(r));
  }

  /** Newest answer of one question (the end of its linear history), or null. */
  latestAnswer(draftId: string, questionId: string): StoredAnswer | null {
    const row = this.db
      .prepare("SELECT * FROM clarification_answers a WHERE a.draft_id = ? AND a.question_id = ? AND NOT EXISTS (SELECT 1 FROM clarification_answers n WHERE n.supersedes_id = a.id)")
      .get(draftId, questionId) as Row | undefined;
    return row ? this.toAnswer(row) : null;
  }

  /**
   * Appends an answer if `expectedPrevious` is still the newest answer of the question (else CONFLICT). The same
   * reading of the same reply on the same basis as the newest one writes nothing (UNCHANGED). The excerpt must
   * occur verbatim in the reply text (checked here and by a trigger).
   */
  answer(link: DraftReplyLink, questionId: string, expectedPrevious: string | null, input: AnswerInput, basis: AnswerBasis, key: string): AnswerOutcome {
    const fingerprint = sha256(JSON.stringify([link.draftId, link.id, questionId, expectedPrevious, input.status, input.excerpt, input.buyerStatement, input.statementKind, input.note]));
    return this.transaction((): AnswerOutcome => {
      const keyed = this.db.prepare("SELECT * FROM clarification_answers WHERE idempotency_key = ?").get(key) as Row | undefined;
      if (keyed) return String(keyed.fingerprint) === fingerprint ? { status: "REPLAYED", answer: this.toAnswer(keyed) } : { status: "KEY_REUSED" };
      const current = this.latestAnswer(link.draftId, questionId);
      if ((current?.id ?? null) !== expectedPrevious) return { status: "CONFLICT", current };
      const sameBasis = current?.basis !== null && current?.basis !== undefined && JSON.stringify(current.basis) === JSON.stringify(basis);
      if (current && current.replyId === link.id && sameBasis && sameAnswer(current, input)) return { status: "UNCHANGED", answer: current };
      if (input.excerpt !== null && !link.reply.rawText.includes(input.excerpt)) return { status: "EXCERPT_NOT_IN_REPLY" };
      const id = `ca_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO clarification_answers (id, draft_id, reply_id, question_id, status, excerpt, buyer_statement, statement_kind, note, basis_json, supersedes_id, idempotency_key, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, link.draftId, link.id, questionId, input.status, input.excerpt, input.buyerStatement, input.statementKind, input.note, JSON.stringify(basis), current?.id ?? null, key, fingerprint, this.now().toISOString());
      return { status: "SAVED", answer: this.toAnswer(this.db.prepare("SELECT * FROM clarification_answers WHERE id = ?").get(id) as Row) };
    });
  }

  /** Drafts of a request that have at least one linked reply. */
  draftsWithReplies(requestId: string): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT d.id FROM clarification_drafts d JOIN clarification_replies r ON r.draft_id = d.id WHERE d.request_id = ? ORDER BY d.created_at, d.id")
        .all(requestId) as Row[]
    ).map((r) => String(r.id));
  }
}
