// Storage for bilingual clarification drafts (schema v10). Same local SQLite file. A draft row and its
// revisions are append-only (triggers refuse UPDATE / DELETE). Nothing here writes to requests, quotes,
// extraction runs, reviews, the budget ledger or payments.

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentKey, type DraftContent, type GeneratedDraft } from "../../lib/clarification.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";

type Row = Record<string, unknown>;

export const CLARIFICATION_DRAFT_ID = /^cd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a draft was generated from, read on the server (never sent by the browser). */
export interface DraftSource {
  requestId: string;
  seriesId: string;
  versionId: string;
  versionNumber: number;
  latestVersionNumber: number;
  contentKind: "FULL_QUOTE" | "SUPPLEMENT";
  rawTextSha256: string;
  snapshotRevision: number;
  currentRequestRevision: number | null;
  run: { id: string; mode: "LIVE" | "MOCK"; provider: string; model: string; checkRules: string; startedAt: string };
  baseRun: { id: string; versionId: string; versionNumber: number } | null;
  /** Reviews of the run (and base run) at generation: count and the newest review id. */
  reviews: { runId: string; count: number; lastId: string | null }[];
  comparatorVersion: string;
  asOf: string;
  /** Short digest of the generated questions (ids + texts), to tell whether the comparison now asks differently. */
  questionsDigest: string;
}

export interface StoredDraft {
  id: string;
  requestId: string;
  seriesId: string;
  versionId: string;
  extractionId: string;
  baseExtractionId: string | null;
  templateVersion: string;
  comparatorVersion: string;
  sourceFingerprint: string;
  source: DraftSource;
  generated: GeneratedDraft;
  supersedesId: string | null;
  createdAt: string;
}

export interface DraftRevision {
  revision: number;
  origin: "GENERATED" | "USER_EDIT";
  content: DraftContent;
  contentSha256: string;
  createdAt: string;
}

export interface DraftSummary {
  id: string;
  versionId: string;
  extractionId: string;
  createdAt: string;
  revision: number;
  supersedesId: string | null;
  questionCount: number;
  selectedCount: number;
}

export type CreateOutcome = { status: "CREATED" | "EXISTING"; draft: StoredDraft };
export type SaveOutcome =
  | { status: "SAVED"; revision: DraftRevision }
  | { status: "UNCHANGED"; revision: DraftRevision }
  | { status: "REPLAYED"; revision: DraftRevision }
  | { status: "KEY_REUSED" }
  | { status: "CONFLICT"; current: DraftRevision };

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class ClarificationStore {
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

  private toDraft(row: Row): StoredDraft {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      seriesId: String(row.series_id),
      versionId: String(row.version_id),
      extractionId: String(row.extraction_id),
      baseExtractionId: row.base_extraction_id === null ? null : String(row.base_extraction_id),
      templateVersion: String(row.template_version),
      comparatorVersion: String(row.comparator_version),
      sourceFingerprint: String(row.source_fingerprint),
      source: JSON.parse(String(row.source_json)) as DraftSource,
      generated: JSON.parse(String(row.generated_json)) as GeneratedDraft,
      supersedesId: row.supersedes_id === null ? null : String(row.supersedes_id),
      createdAt: String(row.created_at),
    };
  }

  private toRevision(row: Row): DraftRevision {
    return {
      revision: Number(row.revision),
      origin: String(row.origin) as DraftRevision["origin"],
      content: JSON.parse(String(row.content_json)) as DraftContent,
      contentSha256: String(row.content_sha256),
      createdAt: String(row.created_at),
    };
  }

  /**
   * One draft per basis (version, run, base run, source fingerprint): a repeated or concurrent create with the
   * same basis returns the existing draft and writes nothing. Revision 1 is the generated text.
   */
  create(input: { source: DraftSource; fingerprint: string; generated: GeneratedDraft; initial: DraftContent; supersedesId: string | null }): CreateOutcome {
    return this.transaction((): CreateOutcome => {
      const s = input.source;
      const existing = this.db
        .prepare("SELECT * FROM clarification_drafts WHERE version_id = ? AND extraction_id = ? AND coalesce(base_extraction_id, '') = ? AND source_fingerprint = ?")
        .get(s.versionId, s.run.id, s.baseRun?.id ?? "", input.fingerprint) as Row | undefined;
      if (existing) return { status: "EXISTING", draft: this.toDraft(existing) };
      const id = `cd_${randomUUID()}`;
      const nowIso = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO clarification_drafts (id, request_id, series_id, version_id, extraction_id, base_extraction_id, template_version, comparator_version,
                                             source_fingerprint, source_json, generated_json, supersedes_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, s.requestId, s.seriesId, s.versionId, s.run.id, s.baseRun?.id ?? null, input.generated.templateVersion, s.comparatorVersion, input.fingerprint, JSON.stringify(s), JSON.stringify(input.generated), input.supersedesId, nowIso);
      this.insertRevision(id, 1, "GENERATED", input.initial, null, nowIso);
      return { status: "CREATED", draft: this.get(id)! };
    });
  }

  private insertRevision(draftId: string, revision: number, origin: DraftRevision["origin"], content: DraftContent, saveKey: string | null, at: string): void {
    const key = contentKey(content);
    this.db
      .prepare("INSERT INTO clarification_draft_revisions (draft_id, revision, origin, content_json, content_sha256, save_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(draftId, revision, origin, JSON.stringify(content), sha256(key), saveKey, at);
  }

  get(id: string): StoredDraft | null {
    const row = this.db.prepare("SELECT * FROM clarification_drafts WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toDraft(row) : null;
  }

  revisions(draftId: string): DraftRevision[] {
    return (this.db.prepare("SELECT * FROM clarification_draft_revisions WHERE draft_id = ? ORDER BY revision").all(draftId) as Row[]).map((r) => this.toRevision(r));
  }

  latest(draftId: string): DraftRevision | null {
    const row = this.db.prepare("SELECT * FROM clarification_draft_revisions WHERE draft_id = ? ORDER BY revision DESC LIMIT 1").get(draftId) as Row | undefined;
    return row ? this.toRevision(row) : null;
  }

  /** Newest first. */
  listForVersion(versionId: string): DraftSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.version_id, d.extraction_id, d.created_at, d.supersedes_id, d.generated_json, r.revision, r.content_json
           FROM clarification_drafts d
           JOIN clarification_draft_revisions r ON r.draft_id = d.id AND r.revision = (SELECT max(revision) FROM clarification_draft_revisions WHERE draft_id = d.id)
          WHERE d.version_id = ?
          ORDER BY d.created_at DESC, d.rowid DESC`,
      )
      .all(versionId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      versionId: String(r.version_id),
      extractionId: String(r.extraction_id),
      createdAt: String(r.created_at),
      revision: Number(r.revision),
      supersedesId: r.supersedes_id === null ? null : String(r.supersedes_id),
      questionCount: (JSON.parse(String(r.generated_json)) as GeneratedDraft).questions.length,
      selectedCount: (JSON.parse(String(r.content_json)) as DraftContent).selected.length,
    }));
  }

  /** Drafts that name this draft as the one they replace (explicit regeneration). */
  successors(draftId: string): string[] {
    return (this.db.prepare("SELECT id FROM clarification_drafts WHERE supersedes_id = ? ORDER BY created_at").all(draftId) as Row[]).map((r) => String(r.id));
  }

  /**
   * Appends a revision if `expectedRevision` is still the latest (else CONFLICT). A save that changes nothing
   * writes nothing (UNCHANGED). The same save key with the same content replays; with other content it is refused.
   */
  save(draftId: string, expectedRevision: number, content: DraftContent, saveKey: string): SaveOutcome {
    const hash = sha256(contentKey(content));
    return this.transaction((): SaveOutcome => {
      const keyed = this.db.prepare("SELECT * FROM clarification_draft_revisions WHERE save_key = ?").get(saveKey) as Row | undefined;
      if (keyed) return String(keyed.draft_id) === draftId && String(keyed.content_sha256) === hash ? { status: "REPLAYED", revision: this.toRevision(keyed) } : { status: "KEY_REUSED" };
      const current = this.latest(draftId)!;
      if (current.revision !== expectedRevision) return { status: "CONFLICT", current };
      if (current.contentSha256 === hash) return { status: "UNCHANGED", revision: current };
      this.insertRevision(draftId, current.revision + 1, "USER_EDIT", content, saveKey, this.now().toISOString());
      return { status: "SAVED", revision: this.latest(draftId)! };
    });
  }

  /** Reviews of a run as the draft records them (count + newest id); read-only. */
  reviewState(runId: string): { runId: string; count: number; lastId: string | null } {
    const row = this.db
      .prepare("SELECT count(*) AS n, (SELECT id FROM quote_extraction_reviews WHERE extraction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last FROM quote_extraction_reviews WHERE extraction_id = ?")
      .get(runId, runId) as Row;
    return { runId, count: Number(row.n), lastId: row.last === null ? null : String(row.last) };
  }
}
