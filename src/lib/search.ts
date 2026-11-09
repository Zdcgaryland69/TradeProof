// Search over procurement requests and quotes (design §3): shapes and normalisation, shared by server
// and page. Pure TypeScript.
//
// Normalisation is for MATCHING only; stored values are never changed and results always show the raw
// value. search key = NFKC (full-width → ASCII) → lower case (locale-independent) → trim → whitespace
// runs collapsed. Hyphens, slashes, dots, "#" and leading zeros are KEPT, so "QT-2026/118" and
// "QT-2026-118" are different keys. A separate "similar" tier drops - _ / . and spaces; it is always
// labelled and never merged with exact matches.

export const SEARCH_LIMITS = { maxQueryChars: 200, maxResults: 50, minShortRefHex: 4 } as const;

export function searchKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function looseKey(s: string): string {
  return searchKey(s).replace(/[-_/.\s]/g, "");
}

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

export type QueryCheck = { ok: true; query: string } | { ok: false; message: string };

/** Bounded, single-line, well-formed text. Empty after trimming = no search. */
export function validateSearchQuery(raw: string): QueryCheck {
  if (!raw.isWellFormed()) return { ok: false, message: "The search text contains invalid characters." };
  if (CONTROL.test(raw)) return { ok: false, message: "The search text cannot contain line breaks or control characters." };
  const query = raw.trim();
  if ([...query].length > SEARCH_LIMITS.maxQueryChars) return { ok: false, message: `Search text is limited to ${SEARCH_LIMITS.maxQueryChars} characters.` };
  return { ok: true, query };
}

export type MatchedField = "REQUEST_ID" | "REQUEST_SHORT_REF" | "QUOTE_REFERENCE" | "QUOTE_SHORT_REF" | "SUPPLIER_QUOTE_NUMBER" | "REQUEST_TITLE" | "QUOTE_NAME";
export type MatchTier = "EXACT" | "PREFIX" | "CONTAINS" | "SIMILAR";

/**
 * Filter by the field that actually matched. Origin (AI candidate / confirmed) is a label, not a category.
 * REQUEST_ID covers full ids and PR- short codes; QUOTE_REFERENCE covers full ids and QS- short codes.
 */
export const SEARCH_CATEGORIES = ["ALL", "REQUEST_ID", "PROCUREMENT_TITLE", "QUOTE_REFERENCE", "SUPPLIER_QUOTE_NUMBER", "QUOTE_NAME"] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];
export const CATEGORY_FIELDS: Record<Exclude<SearchCategory, "ALL">, MatchedField[]> = {
  REQUEST_ID: ["REQUEST_ID", "REQUEST_SHORT_REF"],
  PROCUREMENT_TITLE: ["REQUEST_TITLE"],
  QUOTE_REFERENCE: ["QUOTE_REFERENCE", "QUOTE_SHORT_REF"],
  SUPPLIER_QUOTE_NUMBER: ["SUPPLIER_QUOTE_NUMBER"],
  QUOTE_NAME: ["QUOTE_NAME"],
};
export const SEARCH_SORTS = ["NEWEST", "OLDEST"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/**
 * The date each hit is sorted by = when the record that matched was saved:
 * REQUEST_UPDATED          request fields (ID, title): the request's updated_at
 * QUOTE_SERIES_CREATED     quote name and TradeProof quote reference: the series' created_at (names never change)
 * SUPPLIER_NUMBER_RECORDED supplier quote number: when that number row was recorded
 * Delivery or ship dates are never used. Ties are ordered by a stable id.
 */
export type HitDateMeaning = "REQUEST_UPDATED" | "QUOTE_SERIES_CREATED" | "SUPPLIER_NUMBER_RECORDED";

export function parseCategory(v: string | null | undefined): SearchCategory | null {
  if (v === null || v === undefined || v === "") return "ALL";
  return (SEARCH_CATEGORIES as readonly string[]).includes(v) ? (v as SearchCategory) : null;
}
export function parseSort(v: string | null | undefined): SearchSort | null {
  if (v === null || v === undefined || v === "") return "NEWEST";
  return (SEARCH_SORTS as readonly string[]).includes(v) ? (v as SearchSort) : null;
}

/**
 * Supplier quote number row status:
 * CURRENT   the newest user-side value of that version (entered or confirmed by the user)
 * EARLIER   a user-side value later replaced or cleared ("earlier value")
 * CANDIDATE an AI suggestion — never the confirmed value, whatever the user did later
 */
export type SupplierRefStatus = "CURRENT" | "EARLIER" | "CANDIDATE";

export interface SearchHit {
  matchedField: MatchedField;
  tier: MatchTier;
  /** The stored value that matched, exactly as stored. */
  matchedValue: string;
  request: { id: string; title: string; createdAt: string };
  series: { id: string; name: string; supplierDisplayName: string | null } | null;
  version: { id: string; versionNumber: number; latestVersionNumber: number; savedAt: string } | null;
  supplierRef: { id: string; origin: "USER_ENTERED" | "AI_CANDIDATE" | "USER_CONFIRMED"; status: SupplierRefStatus; createdAt: string } | null;
  /** Sort date of this hit and what it means (see HitDateMeaning). */
  date: { at: string; meaning: HitDateMeaning };
}

export interface SearchResult {
  query: string;
  key: string;
  category: SearchCategory;
  sort: SearchSort;
  hits: SearchHit[];
  /** All matches in the chosen category (counted before the limit), and the requests they belong to. */
  total: number;
  totalRequests: number;
  /** total > hits.length: only the first maxResults (in the chosen order) are returned. */
  truncated: boolean;
  /** A short reference matched several records: they are all listed, none was picked. */
  ambiguous: { field: "REQUEST_SHORT_REF" | "QUOTE_SHORT_REF"; prefix: string; count: number }[];
  /** e.g. a short reference too short to look up. */
  notes: string[];
}
