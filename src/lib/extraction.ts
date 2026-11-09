// AI extraction of one saved quote version: the shapes the server stores and the page shows.
// Pure TypeScript (no Node or React imports), shared by server and browser.
//
// Three different things are kept apart everywhere:
//   1. what the MODEL said            → `modelValue` (kept for review, never trusted on its own)
//   2. what the TEXT supports         → `check` + `evidence`; `value` is set only when check = SUPPORTED
//   3. what the USER confirmed        → separate append-only review rows (ExtractionReview)
// Amounts are parsed from the text by deterministic code into integer minor units; nothing here decides
// a payment amount. Supplier names, numbers and payees in a quote never choose a PayPal payee.

import type { QuoteCurrency } from "./quote.ts";

/** Changes whenever the prompt wording or the expected output shape changes (stored with every run). */
export const EXTRACTION_PROMPT_VERSION = "quote-extract-2026-10-24.1";
/**
 * Version of ExtractionResult below (stored with every run). v2 (25 Oct): number-aware value checks,
 * `checkRules`, per-fact `valueCheck`, AMBIGUOUS_VALUE. Stored v1 results are read as they are.
 */
export const EXTRACTION_SCHEMA_VERSION = "extraction-result-2";
export type ExtractionSchemaVersion = "extraction-result-1" | typeof EXTRACTION_SCHEMA_VERSION;

/** Limits applied before any model call. */
export const EXTRACTION_LIMITS = {
  /** Characters of the version's own text sent to the model; longer text is refused, not cut. */
  maxInputChars: 30_000,
  /** Characters of the supplemented (earlier) version sent as context for a supplement. */
  maxContextChars: 20_000,
  maxOutputTokens: 4_000,
  timeoutMs: 60_000,
  /** Total attempts per run, including one retry for a clearly transient error. Timeouts are never retried. */
  maxAttempts: 2,
  /** Runs per quote version in a rolling 24 h window (LIVE). MOCK runs have their own, higher cap. */
  maxLiveRunsPerVersionPerDay: 3,
  maxMockRunsPerVersionPerDay: 20,
} as const;

export const EXTRACTION_RUN_ID = /^qx_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const EXTRACTION_REVIEW_ID = /^qxr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- evidence ----------

/**
 * SUPPORTED          the excerpt occurs in THIS version's text and (for verbatim facts) contains the value
 * NOT_STATED         the model reports the field as not stated (value stays unknown — never 0)
 * NO_EXCERPT         a value was given without an excerpt
 * NOT_IN_TEXT        the excerpt does not occur in this version's text
 * ONLY_IN_CONTEXT    the excerpt occurs only in the earlier version given as context (supplement)
 * VALUE_NOT_IN_EXCERPT  the excerpt exists but does not contain the stated value / currency
 * SUSPICIOUS_EXCERPT the excerpt reads like an instruction to the assistant (quote text is data only)
 * INVALID_VALUE      the value could not be parsed (amount format, quantity, date, enum)
 * AMBIGUOUS_VALUE    the value may be in the excerpt, but its number format, currency or unit can be read
 *                    more than one way (from 25 Oct) — left for the user, never guessed
 *
 * SUPPORTED never means "semantically verified": it means the excerpt was found and (for verbatim facts)
 * the value passed the code check of `valueCheck`. Whether it belongs to the right item or field is a
 * human review.
 */
export const FACT_CHECKS = [
  "SUPPORTED",
  "NOT_STATED",
  "NO_EXCERPT",
  "NOT_IN_TEXT",
  "ONLY_IN_CONTEXT",
  "VALUE_NOT_IN_EXCERPT",
  "SUSPICIOUS_EXCERPT",
  "INVALID_VALUE",
  "AMBIGUOUS_VALUE",
] as const;
export type FactCheck = (typeof FACT_CHECKS)[number];

/** Where an excerpt was found in the version's stored text (located by the server, not by the model). */
export interface Evidence {
  /** The exact slice of the stored text (may differ from the model's excerpt only in whitespace). */
  excerpt: string;
  /** UTF-16 offsets into the stored raw text: text.slice(start, end) === excerpt. */
  start: number;
  end: number;
  /** 1-based line number of `start`. */
  line: number;
  /** How many places in the text match; > 1 means the location shown is the first of several. */
  occurrences: number;
}

/**
 * VERBATIM: the value itself must appear inside the excerpt (names, numbers, amounts, terms as written).
 * INTERPRETED: the excerpt must exist, but the value is the model's reading of it (payer, payee, included,
 * fee kind); the page says so, and only the user can confirm it.
 */
export type FactKind = "VERBATIM" | "INTERPRETED";

/**
 * How code checked the value against its excerpt (results from 25 Oct on). QUANTITY / AMOUNT /
 * PERCENT compare parsed numbers with digit boundaries and the number's role (count, measure, money,
 * percentage, code); TEXT compares text with digit boundaries. `matches` are offsets into the excerpt.
 */
export interface ValueCheck {
  rules: string;
  field: "QUANTITY" | "AMOUNT" | "PERCENT" | "TEXT";
  outcome: "MATCH" | "NO_MATCH" | "AMBIGUOUS";
  matches: { start: number; end: number; raw: string }[];
  note: string | null;
}

export interface Fact<T> {
  /** Set only when check = SUPPORTED; otherwise null (= unknown, never 0 or a guess). */
  value: T | null;
  /** What the model returned, as text, for review. */
  modelValue: string | null;
  /** The excerpt as the model gave it (before the server located it). */
  modelExcerpt: string | null;
  kind: FactKind;
  check: FactCheck;
  evidence: Evidence | null;
  note: string | null;
  /** Absent in results checked before 25 Oct (24 Oct rule: plain substring test). */
  valueCheck?: ValueCheck;
}

export interface SourcedMoney {
  /** Amount exactly as written in the text, e.g. "11,760.00". */
  amountText: string;
  currency: QuoteCurrency;
  /** Integer minor units, parsed deterministically from amountText. */
  minor: number;
}

// ---------- fees ----------

export const FEE_KINDS = ["GOODS", "FREIGHT", "INSURANCE", "TAX_DUTY", "CUSTOMS_SERVICE", "PAYMENT_FEE", "PACKAGING", "OTHER"] as const;
export type FeeKind = (typeof FEE_KINDS)[number];
export const FEE_PARTIES = ["BUYER", "SUPPLIER", "CARRIER", "INSURER", "GOVERNMENT", "CUSTOMS_BROKER", "PAYMENT_PROVIDER", "OTHER"] as const;
export type FeeParty = (typeof FEE_PARTIES)[number];
export const INCLUDED_VALUES = ["INCLUDED", "NOT_INCLUDED"] as const;
export type Included = (typeof INCLUDED_VALUES)[number];
/** How the QUOTE TEXT states the fee (not whether the user has confirmed it). */
export const FEE_STATED_AS = ["FIRM", "ESTIMATE", "TO_BE_CONFIRMED", "NOT_APPLICABLE"] as const;
export type FeeStatedAs = (typeof FEE_STATED_AS)[number];

export interface FeeLine {
  kind: Fact<FeeKind>;
  description: Fact<string>;
  amount: Fact<SourcedMoney>;
  /** PER_UNIT charges depend on a quantity and are never added up automatically. */
  amountBasis: Fact<"PER_UNIT" | "LUMP_SUM">;
  /** Who pays. Unknown unless the text says so — never invented. */
  payer: Fact<FeeParty>;
  /** Who receives the money. Unknown unless the text says so — never invented; never a PayPal payee. */
  payee: Fact<FeeParty>;
  includedInQuote: Fact<Included>;
  statedAs: Fact<FeeStatedAs>;
}

// ---------- items ----------

/**
 * Proposed link from a quote item to a line of the request snapshot this version was saved with.
 * PROPOSED   exactly one valid candidate — still only a proposal until the user confirms it
 * AMBIGUOUS  several valid candidates — the user must choose
 * UNMATCHED  no valid candidate — the user must choose or mark "no match"
 * Items are never matched by position. Candidate ids that are not lines of that snapshot are dropped
 * and listed in `rejectedIds`.
 */
export interface ItemMatch {
  status: "PROPOSED" | "AMBIGUOUS" | "UNMATCHED";
  candidateIds: string[];
  rejectedIds: string[];
}

export interface ExtractedItem {
  name: Fact<string>;
  quantity: Fact<number>;
  unit: Fact<string>;
  material: Fact<string>;
  specification: Fact<string>;
  logo: Fact<string>;
  unitPrice: Fact<SourcedMoney>;
  match: ItemMatch;
}

/** Deterministic checks computed by code from SUPPORTED facts only. */
export interface ArithmeticCheck {
  code: "TOTAL_MATCHES_ITEMS" | "TOTAL_ARITHMETIC_MISMATCH" | "CANNOT_CHECK_TOTAL";
  message: string;
}

/** Display-only cost overview per currency (never summed across currencies; never a payment amount). */
export interface CostSummaryLine {
  currency: QuoteCurrency;
  quotedTotalMinor: number | null;
  /** Fees the text says are NOT included in the quoted amount and whose amount is supported. */
  extraKnownMinor: number;
  extraKnownCount: number;
}
export interface CostSummary {
  lines: CostSummaryLine[];
  /** Fee lines whose amount, currency or inclusion is unknown — they are not counted anywhere. */
  unknownFeeCount: number;
}

export interface ExtractionResult {
  schemaVersion: ExtractionSchemaVersion;
  /**
   * Version of the value-check rules this result was checked with. Absent = before 25 Oct (plain
   * substring test, no number boundaries): such results keep that scope and are never relabelled.
   */
  checkRules?: string;
  /** The version's declared content kind. A SUPPLEMENT result covers only what that text itself states. */
  contentKind: "FULL_QUOTE" | "SUPPLEMENT";
  supplierQuoteNumbers: Fact<string>[];
  quoteDate: Fact<string>;
  currency: Fact<QuoteCurrency>;
  items: ExtractedItem[];
  total: Fact<SourcedMoney>;
  incoterm: Fact<string>;
  leadTime: Fact<string>;
  paymentTerms: Fact<string>;
  fees: FeeLine[];
  arithmetic: ArithmeticCheck[];
  costSummary: CostSummary;
  /** Facts per check outcome, for the status line. */
  counts: Record<FactCheck, number>;
}

// ---------- runs, reviews, configuration ----------

export const EXTRACTION_STATUSES = ["RUNNING", "SUCCEEDED", "INCOMPLETE", "FAILED"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export interface ExtractionRun {
  id: string;
  versionId: string;
  seriesId: string;
  requestId: string;
  /** Hash of the text the server read for this run (= the version's raw_text_sha256). */
  inputSha256: string;
  /** Request revision of the snapshot the version was saved with (used for item matching). */
  requestRevision: number;
  contextVersionId: string | null;
  /** LIVE = a real model call; MOCK = canned test output, not an AI result. */
  mode: "LIVE" | "MOCK";
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  status: ExtractionStatus;
  /** RUNNING for longer than any call can take: the server stopped before finishing; outcome unknown. */
  interrupted: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string;
  finishedAt: string | null;
  result: ExtractionResult | null;
  /** The model's output exactly as received (for audit). null when no output was received. */
  rawOutput: string | null;
}

export const REVIEW_ACTIONS = ["CONFIRM", "REJECT", "CORRECT", "MATCH_ITEM", "NO_MATCH"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export interface ExtractionReview {
  id: string;
  extractionId: string;
  /** e.g. "total", "items[0].quantity", "items[0].match", "fees[2].payer", "supplierQuoteNumbers[0]". */
  fieldPath: string;
  action: ReviewAction;
  /** CORRECT: the user's own value, as typed (stored as the user's statement, not parsed as evidence). */
  valueText: string | null;
  /** MATCH_ITEM: the request item line chosen by the user (a line of the version's snapshot). */
  requestItemId: string | null;
  supersedesId: string | null;
  createdAt: string;
}

export interface SupplierRef {
  id: string;
  versionId: string;
  valueRaw: string | null;
  origin: "USER_ENTERED" | "AI_CANDIDATE" | "USER_CONFIRMED" | "USER_CLEARED";
  evidenceText: string | null;
  extractionId: string | null;
  supersedesId: string | null;
  createdAt: string;
}

/** What the page may show about the model configuration: names only, never values. */
export type ExtractionConfigState =
  | { state: "NOT_CONFIGURED"; missing: string[]; message: string }
  | { state: "READY"; mode: "LIVE" | "MOCK"; provider: string; model: string };

export const FACT_CHECK_LABELS: Record<FactCheck, string> = {
  SUPPORTED: "Source excerpt found — review required",
  AMBIGUOUS_VALUE: "Number format, currency or unit is ambiguous — check it yourself; not saved as a fact",
  NOT_STATED: "Not stated",
  NO_EXCERPT: "No excerpt given — not saved as a fact",
  NOT_IN_TEXT: "Excerpt not found in this version — not saved as a fact",
  ONLY_IN_CONTEXT: "Found only in the earlier version, not in this text — not saved as a fact",
  VALUE_NOT_IN_EXCERPT: "Value not shown in the excerpt — not saved as a fact",
  SUSPICIOUS_EXCERPT: "Excerpt reads like an instruction — ignored",
  INVALID_VALUE: "Value could not be read — not saved as a fact",
};

/** Problems that make a run INCOMPLETE (NOT_STATED is a normal answer, not a problem). */
export const PROBLEM_CHECKS: FactCheck[] = ["NO_EXCERPT", "NOT_IN_TEXT", "ONLY_IN_CONTEXT", "VALUE_NOT_IN_EXCERPT", "SUSPICIOUS_EXCERPT", "INVALID_VALUE", "AMBIGUOUS_VALUE"];

/** Value-check rules applied by the server now (src/server/extraction/numbers.ts). */
export const CURRENT_CHECK_RULES = "value-check-2026-10-25.1";
/** The value-check rules a stored result was checked with (results before 25 Oct carry none). */
export const LEGACY_CHECK_RULES = "value-check-2026-10-24.0-substring";
export function checkRulesOf(result: ExtractionResult): string {
  return result.checkRules ?? LEGACY_CHECK_RULES;
}
