// Quote series and immutable versions on the shared local SQLite file (schema v6).
//
// Every save runs in ONE transaction (BEGIN IMMEDIATE) that:
//   1. looks up the idempotency key — same key + same content → the original result (a retry after a
//      lost response gets what was saved, even if the series or request has moved on since);
//      same key + different content → refused;
//   2. checks the series belongs to the request in the URL;
//   3. checks the user's version base is still the latest (no silent reordering or overwriting);
//   4. checks the request revision the user saw is still current;
//   5. reads the request and stores its full snapshot (with item ids) next to the text, plus the key.
// The DB triggers refuse UPDATE / DELETE on versions and series, so nothing saved can be overwritten.

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FieldError } from "../../lib/procurement.ts";
import type { QuoteContentKind, QuoteSeries, QuoteSource, QuoteVersion, QuoteVersionSummary, RequestSnapshot } from "../../lib/quote-versions.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";
import { readProcurement } from "../procurement/store.ts";
import type { NormalizedNewSeries, NormalizedNewVersion, NormalizedVersionFields } from "./validate.ts";

type Row = Record<string, unknown>;

export type SaveOutcome =
  | { status: "CREATED" | "REPLAYED"; series: QuoteSeries; version: QuoteVersion }
  | { status: "KEY_REUSED" }
  | { status: "NOT_FOUND" }
  | { status: "INVALID"; errors: FieldError[] }
  | { status: "REQUEST_CHANGED"; currentRevision: number }
  | { status: "VERSION_CONFLICT"; latest: QuoteVersionSummary };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function rowToSummary(row: Row): QuoteVersionSummary {
  return {
    id: String(row.id),
    seriesId: String(row.series_id),
    versionNumber: Number(row.version_number),
    contentKind: String(row.content_kind) as QuoteContentKind,
    supplementsVersionId: text(row.supplements_version_id),
    supplementsVersionNumber: row.supplements_version_number === null || row.supplements_version_number === undefined ? null : Number(row.supplements_version_number),
    source: String(row.source) as QuoteSource,
    sourceNote: text(row.source_note),
    supplierQuoteDate: text(row.supplier_quote_date),
    revisionNote: text(row.revision_note),
    rawTextSha256: String(row.raw_text_sha256),
    rawTextLength: Number(row.raw_text_length),
    requestRevision: Number(row.request_revision),
    savedAt: String(row.saved_at),
  };
}

const SUMMARY_SELECT = `
  SELECT v.id, v.series_id, v.version_number, v.content_kind, v.supplements_version_id,
         t.version_number AS supplements_version_number, v.source, v.source_note, v.supplier_quote_date,
         v.revision_note, v.raw_text_sha256, length(v.raw_text) AS raw_text_length, v.request_revision, v.saved_at
    FROM quote_versions v LEFT JOIN quote_versions t ON t.id = v.supplements_version_id`;

/** Canonical fingerprint of one logical save: operation + target + every submitted value. */
function fingerprint(op: string, requestId: string, seriesId: string | null, fields: object): string {
  return sha256Hex(JSON.stringify([op, requestId, seriesId, fields]));
}

export class QuoteStore {
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

  private seriesRow(requestId: string, seriesId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM quote_series WHERE id = ? AND request_id = ?").get(seriesId, requestId) as Row | undefined;
  }

  private summaries(seriesId: string): QuoteVersionSummary[] {
    return (this.db.prepare(`${SUMMARY_SELECT} WHERE v.series_id = ? ORDER BY v.version_number`).all(seriesId) as Row[]).map(rowToSummary);
  }

  private toSeries(row: Row): QuoteSeries {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      name: String(row.name),
      supplierDisplayName: text(row.supplier_display_name),
      createdAt: String(row.created_at),
      versions: this.summaries(String(row.id)),
    };
  }

  private versionById(id: string): QuoteVersion | null {
    const row = this.db.prepare(`${SUMMARY_SELECT} WHERE v.id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const full = this.db.prepare("SELECT raw_text, request_snapshot FROM quote_versions WHERE id = ?").get(id) as Row;
    return { ...rowToSummary(row), rawText: String(full.raw_text), requestSnapshot: JSON.parse(String(full.request_snapshot)) as RequestSnapshot };
  }

  /** Existing key → replay or refusal; undefined → key not used yet. */
  private replay(key: string, print: string): SaveOutcome | undefined {
    const row = this.db.prepare("SELECT fingerprint, version_id FROM quote_save_keys WHERE key = ?").get(key) as Row | undefined;
    if (!row) return undefined;
    if (String(row.fingerprint) !== print) return { status: "KEY_REUSED" };
    const version = this.versionById(String(row.version_id))!;
    const series = this.db.prepare("SELECT * FROM quote_series WHERE id = ?").get(version.seriesId) as Row;
    return { status: "REPLAYED", series: this.toSeries(series), version };
  }

  private insertVersion(seriesId: string, number: number, fields: NormalizedVersionFields, snapshotRecord: NonNullable<ReturnType<typeof readProcurement>>, key: string, print: string): string {
    const id = `qv_${randomUUID()}`;
    const savedAt = this.now().toISOString();
    const snapshot: RequestSnapshot = { snapshotVersion: 2, capturedAt: savedAt, record: snapshotRecord };
    this.db
      .prepare(
        `INSERT INTO quote_versions
           (id, series_id, version_number, content_kind, supplements_version_id, raw_text, raw_text_sha256, source,
            source_note, supplier_quote_date, revision_note, request_revision, request_snapshot, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        seriesId,
        number,
        fields.contentKind,
        fields.supplementsVersionId,
        fields.rawText,
        sha256Hex(fields.rawText),
        fields.source,
        fields.sourceNote,
        fields.supplierQuoteDate,
        fields.revisionNote,
        snapshotRecord.revision,
        JSON.stringify(snapshot),
        savedAt,
      );
    this.db.prepare("INSERT INTO quote_save_keys (key, fingerprint, version_id, created_at) VALUES (?, ?, ?, ?)").run(key, print, id, savedAt);
    return id;
  }

  createSeries(requestId: string, input: NormalizedNewSeries): SaveOutcome {
    const { idempotencyKey, ...content } = input;
    const print = fingerprint("createSeries", requestId, null, content);
    return this.transaction((): SaveOutcome => {
      const replayed = this.replay(idempotencyKey, print);
      if (replayed) return replayed;
      const record = readProcurement(this.db, requestId);
      if (!record) return { status: "NOT_FOUND" };
      if (record.revision !== input.expectedRequestRevision) return { status: "REQUEST_CHANGED", currentRevision: record.revision };
      const seriesId = `qs_${randomUUID()}`;
      this.db
        .prepare("INSERT INTO quote_series (id, request_id, name, supplier_display_name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(seriesId, requestId, input.name, input.supplierDisplayName, this.now().toISOString());
      const versionId = this.insertVersion(seriesId, 1, input.version, record, idempotencyKey, print);
      return { status: "CREATED", series: this.toSeries(this.seriesRow(requestId, seriesId)!), version: this.versionById(versionId)! };
    });
  }

  addVersion(requestId: string, seriesId: string, input: NormalizedNewVersion): SaveOutcome {
    const { idempotencyKey, ...content } = input;
    const print = fingerprint("addVersion", requestId, seriesId, content);
    return this.transaction((): SaveOutcome => {
      const replayed = this.replay(idempotencyKey, print);
      if (replayed) return replayed;
      const series = this.seriesRow(requestId, seriesId);
      if (!series) return { status: "NOT_FOUND" };
      const versions = this.summaries(seriesId);
      const latest = versions[versions.length - 1];
      const inSeries = (id: string | null) => id !== null && versions.some((v) => v.id === id);
      if (!inSeries(input.expectedLatestVersionId)) {
        return { status: "INVALID", errors: [{ field: "expectedLatestVersionId", message: "That version is not part of this quote." }] };
      }
      if (input.expectedLatestVersionId !== latest.id) return { status: "VERSION_CONFLICT", latest };
      const record = readProcurement(this.db, requestId)!;
      if (record.revision !== input.expectedRequestRevision) return { status: "REQUEST_CHANGED", currentRevision: record.revision };
      if (input.version.contentKind === "SUPPLEMENT" && !inSeries(input.version.supplementsVersionId)) {
        return { status: "INVALID", errors: [{ field: "supplementsVersionId", message: "A supplement can only refer to an earlier version of the same quote." }] };
      }
      const versionId = this.insertVersion(seriesId, latest.versionNumber + 1, input.version, record, idempotencyKey, print);
      return { status: "CREATED", series: this.toSeries(series), version: this.versionById(versionId)! };
    });
  }

  listSeries(requestId: string): QuoteSeries[] {
    return (this.db.prepare("SELECT * FROM quote_series WHERE request_id = ? ORDER BY created_at, id").all(requestId) as Row[]).map((r) => this.toSeries(r));
  }

  /** A version only if it belongs to this series AND the series to this request. */
  getVersion(requestId: string, seriesId: string, versionId: string): QuoteVersion | null {
    if (!this.seriesRow(requestId, seriesId)) return null;
    const version = this.versionById(versionId);
    return version && version.seriesId === seriesId ? version : null;
  }
}
