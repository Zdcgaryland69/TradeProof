// Server-side validation of quote saves. Pure functions (no I/O).
//
// The raw quote text is stored exactly as received: it is never trimmed, re-wrapped, normalised or
// translated. `trim()` is only used to decide whether it is empty. Text is refused (not altered) if it
// contains control characters other than tab / LF / CR, or unpaired UTF-16 surrogates (which could not
// be hashed or stored faithfully as UTF-8).
// Clients cannot send version numbers, timestamps, hashes, snapshots or series of another request:
// those fields are unknown here and set by the server.

import type { FieldError } from "../../lib/procurement.ts";
import {
  IDEMPOTENCY_KEY,
  QUOTE_CONTENT_KINDS,
  QUOTE_LIMITS,
  QUOTE_SOURCES,
  QUOTE_VERSION_ID,
  type QuoteContentKind,
  type QuoteSource,
} from "../../lib/quote-versions.ts";
import { calendarDateError } from "../procurement/validate.ts";

/** Fields every version carries. */
export interface NormalizedVersionFields {
  rawText: string;
  contentKind: QuoteContentKind;
  supplementsVersionId: string | null;
  source: QuoteSource;
  sourceNote: string | null;
  supplierQuoteDate: string | null;
  revisionNote: string | null;
}

export interface NormalizedNewSeries {
  idempotencyKey: string;
  expectedRequestRevision: number;
  name: string;
  supplierDisplayName: string | null;
  version: NormalizedVersionFields;
}

export interface NormalizedNewVersion {
  idempotencyKey: string;
  expectedRequestRevision: number;
  /** The version the user based this revision on (must still be the latest of the series). */
  expectedLatestVersionId: string;
  version: NormalizedVersionFields;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const VERSION_FIELDS = ["rawText", "contentKind", "supplementsVersionId", "source", "sourceNote", "supplierQuoteDate", "revisionNote"];
const SERIES_FIELDS = new Set(["idempotencyKey", "expectedRequestRevision", "name", "supplierDisplayName", ...VERSION_FIELDS]);
const NEW_VERSION_FIELDS = new Set(["idempotencyKey", "expectedRequestRevision", "expectedLatestVersionId", ...VERSION_FIELDS]);

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Errors {
  readonly list: FieldError[] = [];
  add(field: string, message: string): null {
    this.list.push({ field, message });
    return null;
  }

  /** Short metadata text: trimmed; empty → null. */
  meta(body: Record<string, unknown>, key: string, max: number, multiline: boolean): string | null {
    const raw = body[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return this.add(key, "Must be text.");
    const value = raw.replace(/\r\n?/g, "\n").trim();
    if (value === "") return null;
    if (CONTROL_CHARS.test(value) || !value.isWellFormed()) return this.add(key, "Contains characters that are not allowed.");
    if (!multiline && value.includes("\n")) return this.add(key, "Must be a single line.");
    const length = [...value].length;
    if (length > max) return this.add(key, `Too long: ${length} characters (maximum ${max}).`);
    return value;
  }

  unknown(body: Record<string, unknown>, allowed: Set<string>): void {
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) this.add(key, "Unknown field (ids, version numbers, hashes, snapshots and times are set by the server).");
    }
  }

  key(body: Record<string, unknown>): string {
    const raw = body.idempotencyKey;
    if (typeof raw !== "string" || !IDEMPOTENCY_KEY.test(raw)) this.add("idempotencyKey", "A save key (UUID) is required.");
    return typeof raw === "string" ? raw.toLowerCase() : "";
  }

  revision(body: Record<string, unknown>): number {
    const raw = body.expectedRequestRevision;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
      this.add("expectedRequestRevision", "The request revision shown on your page is required.");
      return 0;
    }
    return raw;
  }

  version(body: Record<string, unknown>): NormalizedVersionFields {
    let rawText = "";
    const raw = body.rawText;
    if (typeof raw !== "string") this.add("rawText", "Paste the quote text.");
    else if (raw.trim() === "") this.add("rawText", "The quote text is empty.");
    else if (!raw.isWellFormed()) this.add("rawText", "The text contains broken characters (unpaired surrogates). Copy it again from the source.");
    else if (CONTROL_CHARS.test(raw)) this.add("rawText", "The text contains control characters that are not allowed (only tab and line breaks are).");
    else if ([...raw].length > QUOTE_LIMITS.rawText) this.add("rawText", `Too long: ${[...raw].length} characters (maximum ${QUOTE_LIMITS.rawText}).`);
    else rawText = raw; // stored exactly as received

    const kindRaw = body.contentKind ?? "FULL_QUOTE";
    const contentKind = (QUOTE_CONTENT_KINDS as readonly unknown[]).includes(kindRaw) ? (kindRaw as QuoteContentKind) : null;
    if (!contentKind) this.add("contentKind", `Must be one of ${QUOTE_CONTENT_KINDS.join(", ")}.`);

    let supplementsVersionId: string | null = null;
    const target = body.supplementsVersionId;
    if (contentKind === "SUPPLEMENT") {
      if (typeof target !== "string" || !QUOTE_VERSION_ID.test(target)) this.add("supplementsVersionId", "Choose which earlier version this supplement adds to.");
      else supplementsVersionId = target;
    } else if (target !== undefined && target !== null) {
      this.add("supplementsVersionId", "Only a supplement refers to an earlier version.");
    }

    const source = (QUOTE_SOURCES as readonly unknown[]).includes(body.source) ? (body.source as QuoteSource) : null;
    if (!source) this.add("source", `Must be one of ${QUOTE_SOURCES.join(", ")}.`);

    let supplierQuoteDate: string | null = null;
    const dateRaw = body.supplierQuoteDate;
    if (dateRaw !== undefined && dateRaw !== null && dateRaw !== "") {
      const problem = typeof dateRaw === "string" ? calendarDateError(dateRaw.trim()) : "Must be a date in YYYY-MM-DD format.";
      if (problem) this.add("supplierQuoteDate", problem);
      else supplierQuoteDate = (dateRaw as string).trim();
    }

    return {
      rawText,
      contentKind: contentKind ?? "FULL_QUOTE",
      supplementsVersionId,
      source: source ?? "USER_PASTE",
      sourceNote: this.meta(body, "sourceNote", QUOTE_LIMITS.sourceNote, false),
      supplierQuoteDate,
      revisionNote: this.meta(body, "revisionNote", QUOTE_LIMITS.revisionNote, true),
    };
  }
}

/** POST /api/procurements/:id/quotes — a new series with its first version. */
export function validateNewSeries(body: unknown): Checked<NormalizedNewSeries> {
  if (!isRecord(body)) return { ok: false, errors: [{ field: "", message: "Body must be a JSON object." }] };
  const e = new Errors();
  e.unknown(body, SERIES_FIELDS);
  const idempotencyKey = e.key(body);
  const expectedRequestRevision = e.revision(body);
  const name = e.meta(body, "name", QUOTE_LIMITS.name, false);
  if (name === null && !e.list.some((x) => x.field === "name")) e.add("name", "Give the quote a name, e.g. the supplier's quote number.");
  const supplierDisplayName = e.meta(body, "supplierDisplayName", QUOTE_LIMITS.supplierDisplayName, false);
  const version = e.version(body);
  if (version.contentKind === "SUPPLEMENT") {
    e.add("contentKind", "The first version of a quote must be a full quote; a supplement needs an earlier version to add to.");
  }
  if (e.list.length > 0) return { ok: false, errors: e.list };
  return { ok: true, value: { idempotencyKey, expectedRequestRevision, name: name!, supplierDisplayName, version } };
}

/** POST /api/procurements/:id/quotes/:seriesId/versions — a revision (or supplement) of an existing series. */
export function validateNewVersion(body: unknown): Checked<NormalizedNewVersion> {
  if (!isRecord(body)) return { ok: false, errors: [{ field: "", message: "Body must be a JSON object." }] };
  const e = new Errors();
  e.unknown(body, NEW_VERSION_FIELDS);
  const idempotencyKey = e.key(body);
  const expectedRequestRevision = e.revision(body);
  const latest = body.expectedLatestVersionId;
  if (typeof latest !== "string" || !QUOTE_VERSION_ID.test(latest)) e.add("expectedLatestVersionId", "The version you based this revision on is required.");
  const version = e.version(body);
  if (e.list.length > 0) return { ok: false, errors: e.list };
  return { ok: true, value: { idempotencyKey, expectedRequestRevision, expectedLatestVersionId: latest as string, version } };
}
