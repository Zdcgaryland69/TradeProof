// Storage for AI extraction runs, the user's reviews and supplier quote numbers (schema v7).
// Same local SQLite file. Runs are created RUNNING and finished exactly once (a trigger enforces it);
// reviews and supplier numbers are append-only. Nothing here writes to quote_versions or quote_series.

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EXTRACTION_LIMITS,
  type ExtractionResult,
  type ExtractionReview,
  type ExtractionRun,
  type ExtractionStatus,
  type ReviewAction,
  type SupplierRef,
} from "../../lib/extraction.ts";
import type { RequestSnapshot } from "../../lib/quote-versions.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A RUNNING row older than this cannot still be in progress (timeout × attempts + margin). */
export const STALE_RUNNING_MS = EXTRACTION_LIMITS.timeoutMs * EXTRACTION_LIMITS.maxAttempts + 30_000;

export interface VersionInput {
  requestId: string;
  seriesId: string;
  versionId: string;
  versionNumber: number;
  contentKind: "FULL_QUOTE" | "SUPPLEMENT";
  rawText: string;
  rawTextSha256: string;
  requestRevision: number;
  snapshot: RequestSnapshot;
  /** SUPPLEMENT: the version it adds to (same series). */
  context: { versionId: string; versionNumber: number; rawText: string } | null;
  /** Number of the newest version of the series (to say "a newer version exists"). */
  latestVersionNumber: number;
}

export interface NewRun {
  idempotencyKey: string;
  fingerprint: string;
  mode: "LIVE" | "MOCK";
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  rerun: boolean;
  dailyCap: number;
}

export type BeginOutcome =
  | { status: "STARTED"; run: ExtractionRun }
  | { status: "REPLAYED"; run: ExtractionRun }
  | { status: "KEY_REUSED" }
  | { status: "IN_PROGRESS"; run: ExtractionRun }
  | { status: "ALREADY_EXTRACTED"; run: ExtractionRun }
  | { status: "LIMIT_REACHED"; count: number };

export interface Finish {
  status: Exclude<ExtractionStatus, "RUNNING">;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  rawOutput: string | null;
  result: ExtractionResult | null;
}

export interface NewReview {
  idempotencyKey: string;
  fieldPath: string;
  action: ReviewAction;
  valueText: string | null;
  requestItemId: string | null;
  basedOnReviewId: string | null;
}

export type ReviewOutcome =
  | { status: "CREATED" | "REPLAYED"; review: ExtractionReview }
  | { status: "KEY_REUSED" }
  | { status: "CONFLICT"; latest: ExtractionReview | null };

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class ExtractionStore {
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

  /** The version's stored text and snapshot, read on the server — only if request → series → version belong together. */
  versionInput(requestId: string, seriesId: string, versionId: string): VersionInput | null {
    const row = this.db
      .prepare(
        `SELECT v.*, s.request_id,
                (SELECT max(version_number) FROM quote_versions WHERE series_id = v.series_id) AS latest_number
           FROM quote_versions v JOIN quote_series s ON s.id = v.series_id
          WHERE v.id = ? AND v.series_id = ? AND s.request_id = ?`,
      )
      .get(versionId, seriesId, requestId) as Row | undefined;
    if (!row) return null;
    let context: VersionInput["context"] = null;
    if (row.supplements_version_id) {
      const c = this.db.prepare("SELECT id, version_number, raw_text FROM quote_versions WHERE id = ? AND series_id = ?").get(String(row.supplements_version_id), seriesId) as Row | undefined;
      if (c) context = { versionId: String(c.id), versionNumber: Number(c.version_number), rawText: String(c.raw_text) };
    }
    return {
      requestId,
      seriesId,
      versionId,
      versionNumber: Number(row.version_number),
      contentKind: String(row.content_kind) as VersionInput["contentKind"],
      rawText: String(row.raw_text),
      rawTextSha256: String(row.raw_text_sha256),
      requestRevision: Number(row.request_revision),
      snapshot: JSON.parse(String(row.request_snapshot)) as RequestSnapshot,
      context,
      latestVersionNumber: Number(row.latest_number),
    };
  }

  /** Current revision of the request (read-only; the comparison only reports it, never compares against it). */
  currentRequestRevision(requestId: string): number | null {
    const row = this.db.prepare("SELECT revision FROM procurement_requests WHERE id = ?").get(requestId) as Row | undefined;
    return row ? Number(row.revision) : null;
  }

  private toRun(row: Row): ExtractionRun {
    const status = String(row.status) as ExtractionStatus;
    const startedAt = String(row.started_at);
    return {
      id: String(row.id),
      versionId: String(row.version_id),
      seriesId: String(row.series_id),
      requestId: String(row.request_id),
      inputSha256: String(row.input_sha256),
      requestRevision: Number(row.request_revision),
      contextVersionId: text(row.context_version_id),
      mode: String(row.mode) as ExtractionRun["mode"],
      provider: String(row.provider),
      model: String(row.model),
      promptVersion: String(row.prompt_version),
      schemaVersion: String(row.schema_version),
      status,
      interrupted: status === "RUNNING" && this.now().getTime() - Date.parse(startedAt) > STALE_RUNNING_MS,
      errorCode: text(row.error_code),
      errorMessage: text(row.error_message),
      attempts: Number(row.attempts),
      inputTokens: int(row.input_tokens),
      outputTokens: int(row.output_tokens),
      startedAt,
      finishedAt: text(row.finished_at),
      result: row.result_json ? (JSON.parse(String(row.result_json)) as ExtractionResult) : null,
      rawOutput: text(row.raw_output),
    };
  }

  getRun(id: string): ExtractionRun | null {
    const row = this.db.prepare("SELECT * FROM quote_extraction_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toRun(row) : null;
  }

  /** Newest first. */
  listRuns(versionId: string): ExtractionRun[] {
    return (this.db.prepare("SELECT * FROM quote_extraction_runs WHERE version_id = ? ORDER BY started_at DESC, id DESC").all(versionId) as Row[]).map((r) => this.toRun(r));
  }

  /**
   * One transaction: idempotency key → stale RUNNING rows closed as FAILED (INTERRUPTED) → a run already
   * in progress → an earlier finished run with the same model and prompt (unless `rerun`) → daily cap →
   * insert RUNNING. Only STARTED may lead to a model call.
   */
  beginRun(input: VersionInput, run: NewRun): BeginOutcome {
    return this.transaction((): BeginOutcome => {
      const keyed = this.db.prepare("SELECT * FROM quote_extraction_runs WHERE idempotency_key = ?").get(run.idempotencyKey) as Row | undefined;
      if (keyed) {
        const existing = this.toRun(keyed);
        const sameTarget = existing.versionId === input.versionId && sha256(JSON.stringify([input.versionId, run.rerun])) === run.fingerprint;
        return sameTarget ? { status: "REPLAYED", run: existing } : { status: "KEY_REUSED" };
      }
      const nowIso = this.now().toISOString();
      const staleBefore = new Date(this.now().getTime() - STALE_RUNNING_MS).toISOString();
      this.db
        .prepare(
          `UPDATE quote_extraction_runs SET status = 'FAILED', error_code = 'INTERRUPTED',
                  error_message = 'The server stopped before this run finished. Outcome unknown; it was not retried automatically.',
                  finished_at = ?
            WHERE version_id = ? AND status = 'RUNNING' AND started_at < ?`,
        )
        .run(nowIso, input.versionId, staleBefore);
      const running = this.db.prepare("SELECT * FROM quote_extraction_runs WHERE version_id = ? AND status = 'RUNNING' ORDER BY started_at DESC LIMIT 1").get(input.versionId) as Row | undefined;
      if (running) return { status: "IN_PROGRESS", run: this.toRun(running) };
      if (!run.rerun) {
        const done = this.db
          .prepare(
            `SELECT * FROM quote_extraction_runs
              WHERE version_id = ? AND status IN ('SUCCEEDED', 'INCOMPLETE') AND mode = ? AND provider = ? AND model = ? AND prompt_version = ?
              ORDER BY started_at DESC LIMIT 1`,
          )
          .get(input.versionId, run.mode, run.provider, run.model, run.promptVersion) as Row | undefined;
        if (done) return { status: "ALREADY_EXTRACTED", run: this.toRun(done) };
      }
      const dayAgo = new Date(this.now().getTime() - 24 * 3600_000).toISOString();
      // Runs refused before any model call (attempts = 0, e.g. by the overall budget) do not use up this cap.
      const count = Number(
        (this.db.prepare("SELECT count(*) AS n FROM quote_extraction_runs WHERE version_id = ? AND mode = ? AND started_at >= ? AND NOT (status = 'FAILED' AND attempts = 0)").get(input.versionId, run.mode, dayAgo) as Row).n,
      );
      if (count >= run.dailyCap) return { status: "LIMIT_REACHED", count };
      const id = `qx_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO quote_extraction_runs
             (id, request_id, series_id, version_id, input_sha256, request_revision, context_version_id, mode, provider, model,
              prompt_version, schema_version, idempotency_key, status, attempts, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', 0, ?)`,
        )
        .run(
          id,
          input.requestId,
          input.seriesId,
          input.versionId,
          input.rawTextSha256,
          input.requestRevision,
          input.contentKind === "SUPPLEMENT" ? (input.context?.versionId ?? null) : null,
          run.mode,
          run.provider,
          run.model,
          run.promptVersion,
          run.schemaVersion,
          run.idempotencyKey,
          nowIso,
        );
      return { status: "STARTED", run: this.getRun(id)! };
    });
  }

  /** Finishes a RUNNING run once; supported supplier quote numbers are recorded as AI candidates (never as the value). */
  finishRun(id: string, finish: Finish): ExtractionRun {
    return this.transaction(() => {
      const nowIso = this.now().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE quote_extraction_runs
              SET status = ?, error_code = ?, error_message = ?, attempts = ?, input_tokens = ?, output_tokens = ?,
                  raw_output = ?, result_json = ?, finished_at = ?
            WHERE id = ? AND status = 'RUNNING'`,
        )
        .run(
          finish.status,
          finish.errorCode,
          finish.errorMessage,
          finish.attempts,
          finish.inputTokens,
          finish.outputTokens,
          finish.rawOutput === null ? null : finish.rawOutput.slice(0, 200_000),
          finish.result === null ? null : JSON.stringify(finish.result),
          nowIso,
          id,
        );
      const run = this.getRun(id)!;
      if (Number(changed.changes) === 1 && finish.result) {
        const insert = this.db.prepare(
          "INSERT INTO quote_version_supplier_refs (id, version_id, value_raw, origin, evidence_text, extraction_id, supersedes_id, created_at) VALUES (?, ?, ?, 'AI_CANDIDATE', ?, ?, NULL, ?)",
        );
        for (const q of finish.result.supplierQuoteNumbers) {
          if (q.check === "SUPPORTED" && q.value && q.value.length <= 100) insert.run(`qvr_${randomUUID()}`, run.versionId, q.value, q.evidence!.excerpt, id, nowIso);
        }
      }
      return run;
    });
  }

  private toReview(row: Row): ExtractionReview {
    return {
      id: String(row.id),
      extractionId: String(row.extraction_id),
      fieldPath: String(row.field_path),
      action: String(row.action) as ReviewAction,
      valueText: text(row.value_text),
      requestItemId: text(row.request_item_id),
      supersedesId: text(row.supersedes_id),
      createdAt: String(row.created_at),
    };
  }

  /** Oldest first. */
  reviews(extractionId: string): ExtractionReview[] {
    return (this.db.prepare("SELECT * FROM quote_extraction_reviews WHERE extraction_id = ? ORDER BY created_at, rowid").all(extractionId) as Row[]).map((r) => this.toReview(r));
  }

  supplierRefs(versionId: string): SupplierRef[] {
    return (this.db.prepare("SELECT * FROM quote_version_supplier_refs WHERE version_id = ? ORDER BY created_at, rowid").all(versionId) as Row[]).map((r) => ({
      id: String(r.id),
      versionId: String(r.version_id),
      valueRaw: text(r.value_raw),
      origin: String(r.origin) as SupplierRef["origin"],
      evidenceText: text(r.evidence_text),
      extractionId: text(r.extraction_id),
      supersedesId: text(r.supersedes_id),
      createdAt: String(r.created_at),
    }));
  }

  /**
   * Appends a review if `basedOnReviewId` is still the latest review of that field (else CONFLICT).
   * `supplierRef`: for quote-number reviews, the user-side supplier number row written in the same transaction.
   */
  addReview(run: ExtractionRun, input: NewReview, supplierRef: { origin: "USER_CONFIRMED" | "USER_ENTERED" | "USER_CLEARED"; value: string | null; evidence: string | null } | null): ReviewOutcome {
    const fingerprint = sha256(JSON.stringify([run.id, input.fieldPath, input.action, input.valueText, input.requestItemId, input.basedOnReviewId]));
    return this.transaction((): ReviewOutcome => {
      const keyed = this.db.prepare("SELECT * FROM quote_extraction_reviews WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
      if (keyed) return String(keyed.fingerprint) === fingerprint ? { status: "REPLAYED", review: this.toReview(keyed) } : { status: "KEY_REUSED" };
      const latestRow = this.db
        .prepare("SELECT * FROM quote_extraction_reviews WHERE extraction_id = ? AND field_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(run.id, input.fieldPath) as Row | undefined;
      const latest = latestRow ? this.toReview(latestRow) : null;
      if ((latest?.id ?? null) !== input.basedOnReviewId) return { status: "CONFLICT", latest };
      const id = `qxr_${randomUUID()}`;
      const nowIso = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO quote_extraction_reviews (id, extraction_id, field_path, action, value_text, request_item_id, supersedes_id, idempotency_key, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, run.id, input.fieldPath, input.action, input.valueText, input.requestItemId, latest?.id ?? null, input.idempotencyKey, fingerprint, nowIso);
      if (supplierRef) {
        const current = this.db
          .prepare("SELECT id FROM quote_version_supplier_refs WHERE version_id = ? AND origin <> 'AI_CANDIDATE' ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get(run.versionId) as Row | undefined;
        this.db
          .prepare("INSERT INTO quote_version_supplier_refs (id, version_id, value_raw, origin, evidence_text, extraction_id, supersedes_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(`qvr_${randomUUID()}`, run.versionId, supplierRef.value, supplierRef.origin, supplierRef.evidence, run.id, text(current?.id), nowIso);
      }
      return { status: "CREATED", review: this.toReview(this.db.prepare("SELECT * FROM quote_extraction_reviews WHERE id = ?").get(id) as Row) };
    });
  }
}
