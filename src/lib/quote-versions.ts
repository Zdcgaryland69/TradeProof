// Supplier quotes as saved text: one procurement request → many quote series → many immutable versions.
// Shared by the server (validation, storage) and the browser (display). Pure TypeScript.
//
// What a saved version means — and does not mean:
// - It is the text the user pasted, stored exactly as received, with a SHA-256 of that text for
//   consistency checks. The hash does not prove who wrote the text or that it is genuine.
// - Saving is not confirming, accepting or approving the quote, and does not allow payment.
// - "Latest" = last saved. It is not "accepted".
// - The request snapshot is the request the version was LINKED to when saved. It is not evidence that
//   the supplier received, accepted or promised to meet that request.
// - The supplier display name is what the user typed; it is not a verified identity and never
//   chooses or changes a PayPal payee.

import type { ProcurementRecord } from "./procurement.ts";

/** USER_PASTE = pasted/typed by the user; DEMO_SAMPLE = filled by "Load demo" from samples/synthetic; TEST_FIXTURE = explicitly marked test data. */
export const QUOTE_SOURCES = ["USER_PASTE", "DEMO_SAMPLE", "TEST_FIXTURE"] as const;
export type QuoteSource = (typeof QUOTE_SOURCES)[number];

/** FULL_QUOTE = the user says this is a complete quote; SUPPLEMENT = an addition or fragment that refers to an earlier version. */
export const QUOTE_CONTENT_KINDS = ["FULL_QUOTE", "SUPPLEMENT"] as const;
export type QuoteContentKind = (typeof QUOTE_CONTENT_KINDS)[number];

/** Characters (Unicode code points). Mirrored by CHECKs in the DB schema. */
export const QUOTE_LIMITS = {
  rawText: 100_000,
  name: 200,
  supplierDisplayName: 200,
  sourceNote: 500,
  revisionNote: 1000,
} as const;

/** Whole JSON body in bytes: 100,000 characters can take up to ~600 KB once JSON-escaped. */
export const MAX_QUOTE_BODY_BYTES = 1024 * 1024;

export const QUOTE_SERIES_ID = /^qs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const QUOTE_VERSION_ID = /^qv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Client-generated idempotency key for one logical save (a UUID). */
export const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The request as it was when a quote version was saved. Never updated or re-written afterwards.
 * snapshotVersion 1 (23 Oct, schema v6): no buyer type / person name — those were not recorded then.
 * snapshotVersion 2 (from schema v7): the full record including buyerType and buyerPersonName.
 */
export type RequestSnapshot =
  | { snapshotVersion: 1; capturedAt: string; record: Omit<ProcurementRecord, "buyerType" | "buyerPersonName"> }
  | { snapshotVersion: 2; capturedAt: string; record: ProcurementRecord };

export const CURRENT_SNAPSHOT_VERSION = 2;

/** Buyer fields of a snapshot; `recorded: false` for snapshots taken before they existed (never back-filled). */
export function snapshotBuyer(snapshot: RequestSnapshot): { recorded: false } | { recorded: true; buyerType: ProcurementRecord["buyerType"]; buyerPersonName: string | null } {
  return snapshot.snapshotVersion === 1
    ? { recorded: false }
    : { recorded: true, buyerType: snapshot.record.buyerType, buyerPersonName: snapshot.record.buyerPersonName };
}

export interface QuoteVersionSummary {
  id: string;
  seriesId: string;
  versionNumber: number;
  contentKind: QuoteContentKind;
  /** For SUPPLEMENT: the earlier version of the same series it adds to. */
  supplementsVersionId: string | null;
  supplementsVersionNumber: number | null;
  source: QuoteSource;
  sourceNote: string | null;
  /** Date written on the supplier's quote (YYYY-MM-DD), as entered by the user. */
  supplierQuoteDate: string | null;
  /** The user's own note about this revision; not checked or verified by anyone. */
  revisionNote: string | null;
  rawTextSha256: string;
  /** Characters (code points) in rawText. */
  rawTextLength: number;
  /** Revision of the procurement request linked when this version was saved. */
  requestRevision: number;
  savedAt: string;
}

export interface QuoteVersion extends QuoteVersionSummary {
  rawText: string;
  requestSnapshot: RequestSnapshot;
}

export interface QuoteSeries {
  id: string;
  requestId: string;
  name: string;
  /** As typed by the user. Not a verified identity; not used for payment. */
  supplierDisplayName: string | null;
  createdAt: string;
  /** Oldest first. */
  versions: QuoteVersionSummary[];
}

/** "QS-1A2B3C4D". Display only. */
export function shortSeriesId(id: string): string {
  return `QS-${id.replace(/^qs_/, "").slice(0, 8).toUpperCase()}`;
}

export const QUOTE_SOURCE_LABELS: Record<QuoteSource, string> = {
  USER_PASTE: "Pasted by user",
  DEMO_SAMPLE: "SYNTHETIC / DEMO sample",
  TEST_FIXTURE: "Test data",
};

export const CONTENT_KIND_LABELS: Record<QuoteContentKind, string> = {
  FULL_QUOTE: "Full quote (user-declared)",
  SUPPLEMENT: "Supplement / fragment",
};
