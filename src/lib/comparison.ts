// Comparison of ONE stored extraction run of ONE saved quote version against the request snapshot that
// version was saved with (26 Oct). Pure TypeScript, deterministic, no I/O and no model: the server reads
// every input from the database and passes it here; the page only displays the result.
//
// What a comparison is — and is not:
// - Request snapshot (revision saved with the version) vs. what this run read from the version's text.
//   Today's request is never swapped in silently; if it changed, the result says so.
// - Quote items are paired with request lines through the user's item-match reviews on stable line ids
//   (or, labelled as such, the model's single proposal). Never by position.
// - A value's latest review counts: a user's correction is used (labelled "your statement"), the model's
//   value, its excerpt and its check outcome stay visible. Reviews of other runs never apply.
// - "Source excerpt found" is not semantic verification and not agreement. Wording code cannot read with
//   confidence stays open ("needs clarification"); a short list of phrases like "to be agreed" only adds a
//   reason, its absence proves nothing.
// - Unknown is never 0. Currencies are never converted or added together. Per-unit fees are never
//   allocated to items. Repeated GOODS lines are flagged, never added twice, never deleted.
// - The result only raises differences and clarification questions. It never produces an approved term
//   or a payment amount (approval binds explicitly confirmed terms, 29–30 Oct).

import {
  CURRENT_CHECK_RULES,
  checkRulesOf,
  type Evidence,
  type ExtractionResult,
  type ExtractionReview,
  type ExtractionRun,
  type Fact,
  type FactCheck,
  type FeeLine,
  type SourcedMoney,
} from "./extraction.ts";
import { FEE_KINDS, FEE_STATED_AS, INCLUDED_VALUES } from "./extraction.ts";
import type { ProcurementItem } from "./procurement.ts";
import { comparableFromRecord, parseIncotermRule, parseLeadTimeText, parseLogo, parseMaterialGrade, parsePaymentTerms, type QuoteCurrency } from "./quote.ts";
import type { RequestSnapshot } from "./quote-versions.ts";

/** Stored with nothing (results are computed on demand) but shown on every comparison. */
export const COMPARATOR_VERSION = "compare-2026-10-26.1";

// ---------- binding ----------

export interface VersionFacts {
  id: string;
  seriesId: string;
  requestId: string;
  versionNumber: number;
  latestVersionNumber: number;
  contentKind: "FULL_QUOTE" | "SUPPLEMENT";
  /** SUPPLEMENT: the version it explicitly adds to (same series). */
  supplementsVersionId: string | null;
  supplementsVersionNumber: number | null;
  /** Hash stored with the version. */
  rawTextSha256: string;
  /** Hash recomputed by the server from the stored text just now. */
  computedSha256: string;
  requestRevision: number;
  snapshot: RequestSnapshot;
}

/** Why a run cannot be used as the basis of a comparison (it can still be viewed in the extraction panel). */
export type RunRefusal =
  | "RUN_NOT_FOR_VERSION"
  | "TEXT_HASH_MISMATCH"
  | "RUN_HASH_MISMATCH"
  | "SNAPSHOT_REVISION_MISMATCH"
  | "RUN_NOT_FINISHED"
  | "LEGACY_RULES"
  | "CONTENT_KIND_MISMATCH"
  | "CONTEXT_MISMATCH";

/** null = this run may be compared for this version. Checks ownership, hashes, snapshot revision, status and rules. */
export function runRefusal(run: ExtractionRun, version: VersionFacts): RunRefusal | null {
  if (run.versionId !== version.id || run.seriesId !== version.seriesId || run.requestId !== version.requestId) return "RUN_NOT_FOR_VERSION";
  if (version.computedSha256 !== version.rawTextSha256) return "TEXT_HASH_MISMATCH";
  if (run.inputSha256 !== version.rawTextSha256) return "RUN_HASH_MISMATCH";
  if (run.requestRevision !== version.requestRevision || version.snapshot.record.revision !== version.requestRevision) return "SNAPSHOT_REVISION_MISMATCH";
  if ((run.status !== "SUCCEEDED" && run.status !== "INCOMPLETE") || run.result === null) return "RUN_NOT_FINISHED";
  if (checkRulesOf(run.result) !== CURRENT_CHECK_RULES) return "LEGACY_RULES";
  if (run.result.contentKind !== version.contentKind) return "CONTENT_KIND_MISMATCH";
  if (version.contentKind === "SUPPLEMENT" && (version.supplementsVersionId === null || run.contextVersionId !== version.supplementsVersionId)) return "CONTEXT_MISMATCH";
  return null;
}

// ---------- reviews → the value used ----------

export type ValueOrigin = "MODEL" | "USER_CONFIRMED" | "USER_CORRECTED";
/** PENDING = nobody reviewed it; the other states name the user's latest review of that field in THIS run. */
export type ReviewState = "PENDING" | "CONFIRMED" | "CORRECTED" | "REJECTED";
export type ValueSource = "THIS_VERSION" | "BASE_VERSION";

export interface QuoteValue {
  /** Field path inside the run result, e.g. "items[1].quantity", "fees[0].amount". */
  path: string;
  source: ValueSource;
  versionNumber: number;
  runId: string;
  /** The value the comparison uses, as display text; null = unknown (never 0). */
  used: string | null;
  usedFrom: ValueOrigin | null;
  review: ReviewState;
  reviewId: string | null;
  reviewedAt: string | null;
  /** CORRECT: the user's text exactly as stored, and whether it could be read as this field's type. */
  correctionText: string | null;
  correctionReadable: boolean | null;
  /** What the model said and how the server checked it — always kept, never replaced. */
  modelValue: string | null;
  check: FactCheck;
  interpreted: boolean;
  evidence: Evidence | null;
}

/** How a value (and a user's correction of it) is read. An array = one of these codes (enum fields). */
export type Kind = "TEXT" | "QUANTITY" | "MONEY" | "CURRENCY" | readonly string[];

export interface Used<T> {
  value: T | null;
  view: QuoteValue;
}

const NFKC = (s: string) => s.normalize("NFKC").trim();

/** Strict readers for a user's correction (same formats the extraction accepts; nothing is guessed). */
export function readQuantity(text: string): number | null {
  const t = NFKC(text);
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const CURRENCY_WORDS: [RegExp, QuoteCurrency][] = [
  [/^(?:USD|US\$)$/i, "USD"],
  [/^(?:SGD|S\$)$/i, "SGD"],
  [/^(?:CNY|RMB|人民币)$/i, "CNY"],
];

export function readCurrency(text: string): QuoteCurrency | null {
  const t = NFKC(text);
  return CURRENCY_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
}

// Exact money arithmetic in integer minor units (BigInt; the build target has no bigint literals).
const ZERO = BigInt(0);
const HUNDRED = BigInt(100);

/** "1,234.50" → 123450 (minor units); ambiguous or other formats → null. */
export function readAmount(text: string): bigint | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(NFKC(text));
  if (!m) return null;
  return BigInt(m[1].replace(/,/g, "")) * HUNDRED + BigInt((m[2] ?? "0").padEnd(2, "0"));
}

export interface ExactMoney {
  currency: QuoteCurrency;
  minor: bigint;
}

/** "USD 4.10", "4.10 USD", "US$ 4.10" → money. A bare number or a bare "$" has no currency → null. */
export function readMoney(text: string): ExactMoney | null {
  const t = NFKC(text);
  const m = /^(\S+?)\s*([\d,.]+)$/.exec(t) ?? null;
  const n = /^([\d,.]+)\s*(\S+)$/.exec(t) ?? null;
  for (const [cur, amt] of [m ? [m[1], m[2]] : null, n ? [n[2], n[1]] : null].filter((x): x is string[] => x !== null)) {
    const currency = readCurrency(cur);
    const minor = readAmount(amt);
    if (currency && minor !== null) return { currency, minor };
  }
  return null;
}

export function formatMinor(minor: bigint): string {
  const neg = minor < ZERO;
  const abs = neg ? -minor : minor;
  const whole = (abs / HUNDRED).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${whole}.${(abs % HUNDRED).toString().padStart(2, "0")}`;
}

export const showMoney = (m: ExactMoney) => `${m.currency} ${formatMinor(m.minor)}`;

function modelText(fact: Fact<unknown>): string | null {
  return fact.modelValue;
}

function factValue(kind: Kind, fact: Fact<unknown>): unknown {
  if (fact.check !== "SUPPORTED" || fact.value === null) return null;
  if (kind === "MONEY") {
    const v = fact.value as SourcedMoney;
    return { currency: v.currency, minor: BigInt(v.minor) } satisfies ExactMoney;
  }
  return fact.value;
}

/** "not included" → NOT_INCLUDED; "lump sum" → LUMP_SUM. Only the listed codes are accepted. */
export function readCode(text: string, allowed: readonly string[]): string | null {
  const t = NFKC(text).toUpperCase().replace(/[s-]+/g, "_");
  return allowed.includes(t) ? t : null;
}

function readCorrection(kind: Kind, text: string): unknown {
  if (typeof kind !== "string") return readCode(text, kind);
  if (kind === "QUANTITY") return readQuantity(text);
  if (kind === "MONEY") return readMoney(text);
  if (kind === "CURRENCY") return readCurrency(text);
  const t = text.trim();
  return t === "" ? null : t;
}

function display(kind: Kind, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (kind === "MONEY") return showMoney(value as ExactMoney);
  return String(value);
}

/** The user's latest review of `path` in THIS run (reviews are append-only and linear per field). */
export function latestReview(reviews: readonly ExtractionReview[], path: string): ExtractionReview | null {
  let latest: ExtractionReview | null = null;
  for (const r of reviews) if (r.fieldPath === path) latest = r;
  return latest;
}

export interface Origin {
  run: ExtractionRun;
  reviews: readonly ExtractionReview[];
  source: ValueSource;
  versionNumber: number;
}

export function usedValue<T>(origin: Origin, kind: Kind, path: string, fact: Fact<unknown>): Used<T> {
  // Reviews of other runs are never looked at: only this run's rows are passed in, and they are checked here too.
  const review = latestReview(
    origin.reviews.filter((r) => r.extractionId === origin.run.id),
    path,
  );
  const modelValue = factValue(kind, fact);
  let value: unknown = modelValue;
  let usedFrom: ValueOrigin | null = modelValue === null ? null : "MODEL";
  let state: ReviewState = "PENDING";
  let correctionReadable: boolean | null = null;
  if (review?.action === "CONFIRM") {
    state = "CONFIRMED";
    usedFrom = modelValue === null ? null : "USER_CONFIRMED";
  } else if (review?.action === "REJECT") {
    state = "REJECTED";
    value = null;
    usedFrom = null;
  } else if (review?.action === "CORRECT") {
    state = "CORRECTED";
    const parsed = readCorrection(kind, review.valueText ?? "");
    correctionReadable = parsed !== null;
    value = parsed;
    usedFrom = parsed === null ? null : "USER_CORRECTED";
  }
  return {
    value: value as T | null,
    view: {
      path,
      source: origin.source,
      versionNumber: origin.versionNumber,
      runId: origin.run.id,
      used: display(kind, value),
      usedFrom,
      review: state,
      reviewId: review?.id ?? null,
      reviewedAt: review?.createdAt ?? null,
      correctionText: review?.action === "CORRECT" ? review.valueText : null,
      correctionReadable,
      modelValue: modelText(fact),
      check: fact.check,
      interpreted: fact.kind === "INTERPRETED",
      evidence: fact.evidence,
    },
  };
}

// ---------- result shape ----------

/** MATCH = consistent with the request; DIFFERENCE = differs; OPEN = missing / ambiguous / cannot compare. */
export type Outcome = "MATCH" | "DIFFERENCE" | "OPEN";

export type NoteCode =
  | "MATCH"
  | "MATCH_APPROX_PLACE"
  | "DIFFERENT"
  | "NOT_STATED"
  | "REJECTED_BY_USER"
  | "CORRECTION_UNREADABLE"
  | "VALUE_UNREADABLE"
  | "UNIT_DIFFERS"
  | "REQUEST_WORDING_NOT_RECOGNISED"
  | "QUOTE_WORDING_NOT_RECOGNISED"
  | "FREE_TEXT"
  | "NOT_AGREED"
  | "PARTIAL_TERMS"
  | "CURRENCY_DIFFERS"
  | "SEVERAL_CURRENCIES"
  | "OVER_BUDGET"
  | "WITHIN_BUDGET"
  | "BUDGET_OTHER_CURRENCY"
  | "TOTAL_MATCHES_LINES"
  | "TOTAL_DIFFERS_FROM_LINES"
  | "CANNOT_CHECK_TOTAL"
  | "LEAD_TIME_FITS"
  | "LEAD_TIME_TOO_LATE"
  | "LEAD_TIME_START_UNCLEAR"
  | "LEAD_TIME_APPROXIMATE"
  | "NOT_QUOTED"
  | "PAIRING_NEEDS_CHOICE"
  | "PAIRING_CONFLICT"
  | "EXTRA_QUOTE_ITEM"
  | "INHERITANCE_UNRESOLVED"
  | "SUPPLEMENT_ITEM_FIELD_NOT_STATED";

export interface Note {
  code: NoteCode;
  args: Record<string, string>;
}

export type RowField = "pairing" | "unitPrice" | "quantity" | "material" | "logo" | "specification" | "currency" | "budget" | "arithmetic" | "incoterm" | "leadTime" | "paymentTerms";

export interface ComparisonRow {
  key: string;
  field: RowField;
  /** Request line the row is about (item rows), as a line id of the snapshot. */
  requestItemId: string | null;
  /** Index of the quote item in its run's result (item rows). */
  quoteItemIndex: number | null;
  requestText: string | null;
  quote: QuoteValue[];
  outcome: Outcome;
  note: Note;
  /** The pairing behind an item row is the model's proposal, not the user's decision. */
  provisionalPairing: boolean;
}

export type PairingStatus = "CONFIRMED" | "PROPOSED" | "NEEDS_CHOICE" | "NO_MATCH_BY_USER" | "CONFLICT";

export interface ItemPairing {
  quoteItemIndex: number;
  source: ValueSource;
  quoteItemName: string | null;
  requestItemId: string | null;
  status: PairingStatus;
  candidateIds: string[];
  rejectedIds: string[];
  /** MATCH_ITEM review naming a line that is not in this snapshot (kept visible, never applied). */
  invalidChoice: string | null;
  reviewAt: string | null;
  unitPrice: QuoteValue;
  lineSubtotal: string | null;
}

export type FeeStatus = "KNOWN_EXTRA" | "INCLUDED" | "NOT_APPLICABLE" | "OPEN" | "SUSPECTED_DUPLICATE";
export type FeeReason =
  | "AMOUNT_NOT_STATED"
  | "AMOUNT_OR_CURRENCY_UNCLEAR"
  | "INCLUSION_UNKNOWN"
  | "NOT_FIRM"
  | "PER_UNIT_NOT_ALLOCATED"
  | "BASIS_UNKNOWN"
  | "GOODS_REPEAT"
  | "GOODS_EQUALS_TOTAL"
  | "GOODS_EQUALS_ITEM_PRICE"
  | "GOODS_EQUALS_LINE";

export interface FeeView {
  index: number;
  source: ValueSource;
  versionNumber: number;
  status: FeeStatus;
  reasons: FeeReason[];
  kind: QuoteValue;
  description: QuoteValue;
  amount: QuoteValue;
  basis: QuoteValue;
  included: QuoteValue;
  statedAs: QuoteValue;
  payer: QuoteValue;
}

export interface CostLineView {
  currency: QuoteCurrency;
  statedGoodsTotal: string | null;
  sumOfItemLines: string | null;
  knownExtras: string;
  knownExtraCount: number;
}

export interface CostView {
  computed: boolean;
  lines: CostLineView[];
  openCount: number;
  duplicateCount: number;
  /** Always false: the quote text may not mention every cost. */
  complete: false;
  /** Always null: nothing here is a payment amount. */
  paymentAmount: null;
}

export interface Question {
  key: string;
  code: "CONFIRM_DIFFERENCE" | "STATE_VALUE" | "STATE_AGREED_TERM" | "CLARIFY_FEE" | "CONFIRM_DUPLICATE" | "CLARIFY_UNIT" | "CLARIFY_ITEM";
  args: Record<string, string>;
}

export interface Binding {
  comparatorVersion: string;
  asOf: string;
  requestId: string;
  snapshotRevision: number;
  currentRequestRevision: number | null;
  requestUpdated: boolean;
  version: { id: string; versionNumber: number; latestVersionNumber: number; contentKind: "FULL_QUOTE" | "SUPPLEMENT"; rawTextSha256: string };
  run: { id: string; mode: "LIVE" | "MOCK"; provider: string; model: string; promptVersion: string; checkRules: string; status: string; startedAt: string };
  base: null | {
    versionId: string;
    versionNumber: number;
    rawTextSha256: string;
    snapshotRevision: number;
    run: null | { id: string; mode: "LIVE" | "MOCK"; model: string; checkRules: string; startedAt: string };
  };
}

export interface Comparison {
  binding: Binding;
  pairings: ItemPairing[];
  /** Request lines in snapshot order (display only; pairing never uses the order). */
  requestLines: { id: string; position: number; name: string; quantity: number | null; unit: string | null }[];
  rows: ComparisonRow[];
  fees: FeeView[];
  cost: CostView;
  questions: Question[];
  /** SUPPLEMENT: fields neither restated by the supplement nor resolvable from a base run. */
  unresolvedInheritance: string[];
  /** SUPPLEMENT: where each request-level term comes from (empty for a full quote). */
  inheritance: InheritanceEntry[];
  summary: {
    differences: number;
    open: number;
    matches: number;
    valuesUsed: number;
    confirmed: number;
    corrected: number;
    pending: number;
    rejected: number;
    pairsConfirmed: number;
    pairsProposed: number;
    pairsOpen: number;
  };
  /** Only discrepancies and clarification questions come out of this; never approved terms or a payment amount. */
  use: "DISCREPANCIES_AND_QUESTIONS_ONLY";
}

export interface InheritanceEntry {
  field: "currency" | "total" | "incoterm" | "leadTime" | "paymentTerms";
  status: "STATED_IN_SUPPLEMENT" | "CHANGED_BY_SUPPLEMENT" | "INHERITED" | "UNRESOLVED";
  views: QuoteValue[];
}

export interface ComparisonInput {
  version: VersionFacts;
  run: ExtractionRun;
  reviews: readonly ExtractionReview[];
  currentRequestRevision: number | null;
  /** SUPPLEMENT only: the explicitly linked base version and the run chosen for it (null = none chosen / none usable). */
  base: null | { version: VersionFacts; run: ExtractionRun | null; reviews: readonly ExtractionReview[] };
  /** YYYY-MM-DD (Singapore day) used for the lead-time check. */
  asOf: string;
}

// ---------- helpers ----------

/**
 * Phrases that mark a term as not yet agreed. A hint only: the comparison treats any wording it cannot
 * parse as open anyway, so a phrase missing from this list never makes a term "agreed".
 */
const NOT_AGREED =
  /to be (?:agreed|confirmed|advised|determined|discussed|negotiated|decided)|\btb[acd]\b|subject to|after sample|upon (?:sample )?approval|pending|negotiable|待定|另议|协商|待确认|面议|视情况|待.{0,6}后(?:确定|约定)|样品确认后/i;

export function looksNotAgreed(text: string): boolean {
  return NOT_AGREED.test(text);
}

const UNIT_GROUPS: [RegExp, string][] = [
  [/^(?:pcs?|pieces?|units?|ea|each|个|只|件|支|把)$/i, "piece"],
  [/^(?:sets?|套)$/i, "set"],
  [/^(?:boxe?s?|盒)$/i, "box"],
  [/^(?:cartons?|ctns?|箱)$/i, "carton"],
  [/^(?:pairs?|双|对)$/i, "pair"],
];

function unitKey(u: string): string {
  const t = NFKC(u).replace(/\.$/, "").toLowerCase();
  return UNIT_GROUPS.find(([re]) => re.test(t))?.[1] ?? t;
}

function addDays(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** OPEN reason for a value that is not usable. */
function missingNote(v: QuoteValue): Note {
  if (v.review === "REJECTED") return { code: "REJECTED_BY_USER", args: {} };
  if (v.review === "CORRECTED" && v.correctionReadable === false) return { code: "CORRECTION_UNREADABLE", args: { text: v.correctionText ?? "" } };
  if (v.check === "NOT_STATED") return { code: "NOT_STATED", args: {} };
  return { code: "VALUE_UNREADABLE", args: { check: v.check } };
}

// ---------- main ----------

export function compareExtraction(input: ComparisonInput): Comparison {
  const { version, run, reviews } = input;
  const result = run.result as ExtractionResult;
  const snapshot = version.snapshot.record;
  const request = comparableFromRecord(snapshot as Parameters<typeof comparableFromRecord>[0]);
  const lineIds = new Set(snapshot.items.map((i) => i.id));
  const lineById = new Map(snapshot.items.map((i) => [i.id, i] as const));
  const rows: ComparisonRow[] = [];
  const questions: Question[] = [];
  const unresolved: string[] = [];
  const inheritance: InheritanceEntry[] = [];
  const isSupplement = version.contentKind === "SUPPLEMENT";
  const self: Origin = { run, reviews, source: "THIS_VERSION", versionNumber: version.versionNumber };
  const baseRun = input.base?.run && input.base.run.result ? input.base.run : null;
  const base: Origin | null = baseRun && input.base ? { run: baseRun, reviews: input.base.reviews, source: "BASE_VERSION", versionNumber: input.base.version.versionNumber } : null;
  const baseResult = baseRun?.result ?? null;

  const lineLabel = (id: string | null) => (id ? (lineById.get(id)?.name ?? id) : "");
  const ask = (code: Question["code"], args: Record<string, string>) => questions.push({ key: `q${questions.length}`, code, args });

  // ---- item pairing (stable ids, never position) ----
  type Paired = { origin: Origin; result: ExtractionResult; index: number; pairing: ItemPairing };
  const paired: Paired[] = [];
  const pairItems = (origin: Origin, res: ExtractionResult) =>
    res.items.forEach((item, index) => {
      const review = latestReview(origin.reviews.filter((r) => r.extractionId === origin.run.id), `items[${index}].match`);
      let status: PairingStatus;
      let requestItemId: string | null = null;
      let invalidChoice: string | null = null;
      if (review?.action === "MATCH_ITEM") {
        if (review.requestItemId && lineIds.has(review.requestItemId)) {
          status = "CONFIRMED";
          requestItemId = review.requestItemId;
        } else {
          status = "NEEDS_CHOICE";
          invalidChoice = review.requestItemId;
        }
      } else if (review?.action === "NO_MATCH") {
        status = "NO_MATCH_BY_USER";
      } else {
        const valid = item.match.candidateIds.filter((id) => lineIds.has(id));
        if (item.match.status === "PROPOSED" && valid.length === 1) {
          status = "PROPOSED";
          requestItemId = valid[0];
        } else status = "NEEDS_CHOICE";
      }
      const unitPrice = usedValue<ExactMoney>(origin, "MONEY", `items[${index}].unitPrice`, item.unitPrice);
      const qty = usedValue<number>(origin, "QUANTITY", `items[${index}].quantity`, item.quantity);
      const name = usedValue<string>(origin, "TEXT", `items[${index}].name`, item.name);
      paired.push({
        origin,
        result: res,
        index,
        pairing: {
          quoteItemIndex: index,
          source: origin.source,
          quoteItemName: name.value ?? item.name.modelValue,
          requestItemId,
          status,
          candidateIds: item.match.candidateIds,
          rejectedIds: item.match.rejectedIds,
          invalidChoice,
          reviewAt: review?.createdAt ?? null,
          unitPrice: unitPrice.view,
          lineSubtotal: unitPrice.value && qty.value !== null ? showMoney({ currency: unitPrice.value.currency, minor: unitPrice.value.minor * BigInt(qty.value) }) : null,
        },
      });
    });

  // Supplement: its own items first; request lines it does not cover fall back to the base run, labelled.
  if (isSupplement) {
    pairItems(self, result);
    if (base && baseResult) {
      const covered = new Set(paired.map((p) => p.pairing.requestItemId).filter((x): x is string => x !== null));
      const before = paired.length;
      pairItems(base, baseResult);
      // Base items paired with a line the supplement already covers are not merged into it.
      for (const p of paired.slice(before)) if (p.pairing.requestItemId && covered.has(p.pairing.requestItemId)) p.pairing.status = "CONFLICT";
    }
  } else pairItems(self, result);

  // Several quote items on one line → none of them is compared (quantities are never summed silently).
  const perLine = new Map<string, Paired[]>();
  for (const p of paired) {
    if ((p.pairing.status === "CONFIRMED" || p.pairing.status === "PROPOSED") && p.pairing.requestItemId) {
      perLine.set(p.pairing.requestItemId, [...(perLine.get(p.pairing.requestItemId) ?? []), p]);
    }
  }
  for (const list of perLine.values()) if (list.length > 1) for (const p of list) p.pairing.status = "CONFLICT";

  // ---- item rows ----
  for (const p of paired) {
    const { pairing, origin, index } = p;
    const item = p.result.items[index];
    const nameView = usedValue<string>(origin, "TEXT", `items[${index}].name`, item.name).view;
    const label = pairing.quoteItemName ?? `#${index + 1}`;
    if (pairing.status === "NEEDS_CHOICE" || pairing.status === "CONFLICT") {
      rows.push({
        key: `pair-${origin.source}-${index}`,
        field: "pairing",
        requestItemId: pairing.status === "CONFLICT" ? pairing.requestItemId : null,
        quoteItemIndex: index,
        requestText: pairing.status === "CONFLICT" ? lineLabel(pairing.requestItemId) : null,
        quote: [nameView],
        outcome: "OPEN",
        note: { code: pairing.status === "CONFLICT" ? "PAIRING_CONFLICT" : "PAIRING_NEEDS_CHOICE", args: { candidates: String(pairing.candidateIds.length) } },
        provisionalPairing: false,
      });
      ask("CLARIFY_ITEM", { item: label });
      continue;
    }
    if (pairing.status === "NO_MATCH_BY_USER") {
      rows.push({
        key: `pair-${origin.source}-${index}`,
        field: "pairing",
        requestItemId: null,
        quoteItemIndex: index,
        requestText: null,
        quote: [nameView],
        outcome: "DIFFERENCE",
        note: { code: "EXTRA_QUOTE_ITEM", args: {} },
        provisionalPairing: false,
      });
      ask("CLARIFY_ITEM", { item: label });
      continue;
    }
    const line = lineById.get(pairing.requestItemId!)!;
    const provisional = pairing.status === "PROPOSED";
    const supplementItem = origin.source === "THIS_VERSION" && isSupplement;
    const push = (field: RowField, requestText: string | null, q: QuoteValue, outcome: Outcome, note: Note) =>
      rows.push({ key: `${field}-${origin.source}-${index}`, field, requestItemId: line.id, quoteItemIndex: index, requestText, quote: [q], outcome, note, provisionalPairing: provisional });
    const notStated = (q: QuoteValue): Note => (supplementItem && q.check === "NOT_STATED" && q.review === "PENDING" ? { code: "SUPPLEMENT_ITEM_FIELD_NOT_STATED", args: {} } : missingNote(q));
    compareItem(line, item, origin, index, push, notStated, (field, outcome, args) => {
      if (outcome === "DIFFERENCE") ask("CONFIRM_DIFFERENCE", { field, item: line.name, ...args });
      else if (field === "unit") ask("CLARIFY_UNIT", { item: line.name, ...args });
      else ask("STATE_VALUE", { field, item: line.name, ...args });
    });
  }

  // Request lines with no paired quote item.
  const pairedLines = new Set(paired.filter((p) => p.pairing.status === "CONFIRMED" || p.pairing.status === "PROPOSED" || p.pairing.status === "CONFLICT").map((p) => p.pairing.requestItemId));
  for (const line of snapshot.items) {
    if (pairedLines.has(line.id)) continue;
    const inherited = isSupplement && !base;
    rows.push({
      key: `line-${line.id}`,
      field: "pairing",
      requestItemId: line.id,
      quoteItemIndex: null,
      requestText: line.name,
      quote: [],
      outcome: "OPEN",
      note: { code: inherited ? "INHERITANCE_UNRESOLVED" : "NOT_QUOTED", args: {} },
      provisionalPairing: false,
    });
    if (inherited) unresolved.push(`item:${line.id}`);
    else ask("CLARIFY_ITEM", { item: line.name });
  }

  // ---- request-level terms ----
  type TermKey = "currency" | "total" | "incoterm" | "leadTime" | "paymentTerms";
  const termKind: Record<TermKey, Kind> = { currency: "CURRENCY", total: "MONEY", incoterm: "TEXT", leadTime: "TEXT", paymentTerms: "TEXT" };
  /** A term's value: this version's, or for a supplement that does not restate it, the base run's (labelled). */
  const term = <T,>(key: TermKey): { value: T | null; views: QuoteValue[]; inherited: boolean } => {
    const own = usedValue<T>(self, termKind[key], key, result[key] as Fact<unknown>);
    if (!isSupplement) return { value: own.value, views: [own.view], inherited: false };
    const restated = own.value !== null || own.view.review !== "PENDING";
    if (restated) {
      const prior = base && baseResult ? usedValue<T>(base, termKind[key], key, baseResult[key] as Fact<unknown>) : null;
      const changed = prior !== null && prior.view.used !== null && prior.view.used !== own.view.used;
      inheritance.push({ field: key, status: changed ? "CHANGED_BY_SUPPLEMENT" : "STATED_IN_SUPPLEMENT", views: changed ? [own.view, prior.view] : [own.view] });
      return { value: own.value, views: changed ? [own.view, prior.view] : [own.view], inherited: false };
    }
    if (base && baseResult) {
      const prior = usedValue<T>(base, termKind[key], key, baseResult[key] as Fact<unknown>);
      inheritance.push({ field: key, status: "INHERITED", views: [prior.view] });
      return { value: prior.value, views: [prior.view, own.view], inherited: true };
    }
    unresolved.push(key);
    inheritance.push({ field: key, status: "UNRESOLVED", views: [own.view] });
    return { value: null, views: [own.view], inherited: true };
  };
  const unresolvedNote = (key: TermKey, v: QuoteValue): Note => (isSupplement && !base && unresolved.includes(key) ? { code: "INHERITANCE_UNRESOLVED", args: {} } : missingNote(v));
  const termRow = (field: RowField, requestText: string | null, quote: QuoteValue[], outcome: Outcome, note: Note) =>
    rows.push({ key: `term-${field}`, field, requestItemId: null, quoteItemIndex: null, requestText, quote, outcome, note, provisionalPairing: false });

  const currency = term<QuoteCurrency>("currency");
  const total = term<ExactMoney>("total");
  const budget = request.budget ? { currency: request.budget.currency, minor: BigInt(request.budget.minor) } : null;
  const budgetText = budget ? `${showMoney(budget)} (budget cap)` : null;

  // Currencies seen anywhere in the used values (never converted).
  const itemPrices = paired.map((p) => usedValue<ExactMoney>(p.origin, "MONEY", `items[${p.index}].unitPrice`, p.result.items[p.index].unitPrice).value);
  const seen = new Set<QuoteCurrency>([currency.value, total.value?.currency ?? null, ...itemPrices.map((m) => m?.currency ?? null)].filter((c): c is QuoteCurrency => c !== null));

  // A currency row whenever the quote names amounts: an unknown currency is never assumed (e.g. a bare "$").
  const amountsMentioned = total.views.some((v) => v.modelValue !== null) || paired.some((p) => p.pairing.unitPrice.modelValue !== null);
  if (budget || currency.value !== null || currency.views[0].modelValue !== null || amountsMentioned) {
    if (seen.size > 1) {
      termRow("currency", budget?.currency ?? null, currency.views, "OPEN", { code: "SEVERAL_CURRENCIES", args: { list: [...seen].join(", ") } });
      ask("STATE_VALUE", { field: "currency", item: "" });
    } else if (currency.value === null && seen.size === 0) {
      termRow("currency", budget?.currency ?? null, currency.views, "OPEN", unresolvedNote("currency", currency.views[0]));
      ask("STATE_VALUE", { field: "currency", item: "" });
    } else {
      const quoted = currency.value ?? [...seen][0];
      if (!budget) {
        // No budget currency in the request: nothing to compare against.
      } else if (quoted === budget.currency) {
        termRow("currency", budget.currency, currency.views, "MATCH", { code: "MATCH", args: {} });
      } else {
        termRow("currency", budget.currency, currency.views, "DIFFERENCE", { code: "CURRENCY_DIFFERS", args: { quoted, wanted: budget.currency } });
        ask("CONFIRM_DIFFERENCE", { field: "currency", item: "", quoted, wanted: budget.currency });
      }
    }
  }

  if (budget) {
    if (total.value === null) {
      termRow("budget", budgetText, total.views, "OPEN", unresolvedNote("total", total.views[0]));
      ask("STATE_VALUE", { field: "total", item: "" });
    } else if (total.value.currency !== budget.currency) {
      termRow("budget", budgetText, total.views, "OPEN", { code: "BUDGET_OTHER_CURRENCY", args: { quoted: total.value.currency, wanted: budget.currency } });
    } else if (total.value.minor > budget.minor) {
      termRow("budget", budgetText, total.views, "DIFFERENCE", { code: "OVER_BUDGET", args: { total: showMoney(total.value), budget: showMoney(budget) } });
      ask("CONFIRM_DIFFERENCE", { field: "total", item: "", quoted: showMoney(total.value), wanted: showMoney(budget) });
    } else {
      termRow("budget", budgetText, total.views, "MATCH", { code: "WITHIN_BUDGET", args: { total: showMoney(total.value), budget: showMoney(budget) } });
    }
  }

  // Arithmetic over this version's own items (a supplement's partial lines are not summed with the base's).
  const arithmeticItems = isSupplement && result.items.length === 0 && base && baseResult ? { origin: base, res: baseResult } : { origin: self, res: result };
  let sumOfLines: ExactMoney | null = null;
  {
    const lines = arithmeticItems.res.items.map((it, i) => ({
      qty: usedValue<number>(arithmeticItems.origin, "QUANTITY", `items[${i}].quantity`, it.quantity).value,
      price: usedValue<ExactMoney>(arithmeticItems.origin, "MONEY", `items[${i}].unitPrice`, it.unitPrice).value,
    }));
    const ok = lines.length > 0 && lines.every((l) => l.qty !== null && l.price !== null) && new Set(lines.map((l) => l.price!.currency)).size === 1;
    if (ok) sumOfLines = { currency: lines[0].price!.currency, minor: lines.reduce((acc, l) => acc + l.price!.minor * BigInt(l.qty!), ZERO) };
    if (!isSupplement || result.items.length > 0 || total.value !== null) {
      if (sumOfLines && total.value && sumOfLines.currency === total.value.currency) {
        const same = sumOfLines.minor === total.value.minor;
        termRow("arithmetic", null, total.views, same ? "MATCH" : "DIFFERENCE", { code: same ? "TOTAL_MATCHES_LINES" : "TOTAL_DIFFERS_FROM_LINES", args: { sum: showMoney(sumOfLines), total: showMoney(total.value) } });
        if (!same) ask("CONFIRM_DIFFERENCE", { field: "arithmetic", item: "", quoted: showMoney(total.value), wanted: showMoney(sumOfLines) });
      } else {
        termRow("arithmetic", null, total.views, "OPEN", { code: "CANNOT_CHECK_TOTAL", args: {} });
      }
    }
  }

  // Incoterm.
  {
    const inc = term<string>("incoterm");
    const text = inc.value;
    const wanted = request.incotermRule;
    if (text !== null && looksNotAgreed(text)) {
      termRow("incoterm", request.incotermText, inc.views, "OPEN", { code: "NOT_AGREED", args: { text } });
      ask("STATE_AGREED_TERM", { field: "incoterm", text });
    } else if (wanted) {
      if (text === null) {
        termRow("incoterm", request.incotermText, inc.views, "OPEN", unresolvedNote("incoterm", inc.views[0]));
        ask("STATE_VALUE", { field: "incoterm", item: "" });
      } else {
        const rule = parseIncotermRule(text);
        if (!rule) termRow("incoterm", request.incotermText, inc.views, "OPEN", { code: "QUOTE_WORDING_NOT_RECOGNISED", args: {} });
        else if (rule === wanted) termRow("incoterm", request.incotermText, inc.views, "MATCH", { code: "MATCH_APPROX_PLACE", args: { rule } });
        else {
          termRow("incoterm", request.incotermText, inc.views, "DIFFERENCE", { code: "DIFFERENT", args: { quoted: rule, wanted } });
          ask("CONFIRM_DIFFERENCE", { field: "incoterm", item: "", quoted: rule, wanted });
        }
      }
    } else if (text !== null && (snapshot.shipFrom || snapshot.additionalRequirements)) {
      termRow("incoterm", snapshot.shipFrom ?? snapshot.additionalRequirements, inc.views, "OPEN", { code: "REQUEST_WORDING_NOT_RECOGNISED", args: {} });
    }
  }

  // Lead time against the required ship date.
  {
    const lt = term<string>("leadTime");
    const text = lt.value;
    const shipBy = request.requiredShipDate;
    const reqText = shipBy ? `ship by ${shipBy}` : null;
    if (text !== null && looksNotAgreed(text)) {
      termRow("leadTime", reqText, lt.views, "OPEN", { code: "NOT_AGREED", args: { text } });
      ask("STATE_AGREED_TERM", { field: "leadTime", text });
    } else if (shipBy) {
      const parsed = text === null ? null : parseLeadTimeText(text);
      if (text === null) {
        termRow("leadTime", reqText, lt.views, "OPEN", unresolvedNote("leadTime", lt.views[0]));
        ask("STATE_VALUE", { field: "leadTime", item: "" });
      } else if (!parsed) {
        termRow("leadTime", reqText, lt.views, "OPEN", { code: "QUOTE_WORDING_NOT_RECOGNISED", args: {} });
        ask("STATE_VALUE", { field: "leadTime", item: "" });
      } else {
        const depositBy = addDays(shipBy, -parsed.days);
        const args = { days: String(parsed.days), depositBy, shipBy, asOf: input.asOf };
        if (parsed.basis !== "AFTER_DEPOSIT") termRow("leadTime", reqText, lt.views, "OPEN", { code: "LEAD_TIME_START_UNCLEAR", args });
        else if (input.asOf > depositBy) {
          termRow("leadTime", reqText, lt.views, "DIFFERENCE", { code: "LEAD_TIME_TOO_LATE", args });
          ask("CONFIRM_DIFFERENCE", { field: "leadTime", item: "", quoted: text, wanted: reqText! });
        } else if (parsed.approximate) termRow("leadTime", reqText, lt.views, "OPEN", { code: "LEAD_TIME_APPROXIMATE", args });
        else termRow("leadTime", reqText, lt.views, "MATCH", { code: "LEAD_TIME_FITS", args });
      }
    }
  }

  // Payment terms: only a cleanly parsed deposit / balance is compared; anything else stays open.
  {
    const pt = term<string>("paymentTerms");
    const text = pt.value;
    const reqText = request.paymentTermsText;
    if (text !== null && looksNotAgreed(text)) {
      termRow("paymentTerms", reqText, pt.views, "OPEN", { code: "NOT_AGREED", args: { text } });
      ask("STATE_AGREED_TERM", { field: "paymentTerms", text });
    } else if (reqText) {
      const got = text === null ? null : parsePaymentTerms(text);
      const want = request.paymentTerms;
      if (text === null) {
        termRow("paymentTerms", reqText, pt.views, "OPEN", unresolvedNote("paymentTerms", pt.views[0]));
        ask("STATE_VALUE", { field: "paymentTerms", item: "" });
      } else if (!want) termRow("paymentTerms", reqText, pt.views, "OPEN", { code: "REQUEST_WORDING_NOT_RECOGNISED", args: {} });
      else if (!got) {
        termRow("paymentTerms", reqText, pt.views, "OPEN", { code: "QUOTE_WORDING_NOT_RECOGNISED", args: {} });
        ask("STATE_AGREED_TERM", { field: "paymentTerms", text });
      } else if (got.depositPercent !== want.depositPercent || (got.balanceTiming !== null && want.balanceTiming !== null && got.balanceTiming !== want.balanceTiming)) {
        termRow("paymentTerms", reqText, pt.views, "DIFFERENCE", { code: "DIFFERENT", args: { quoted: text, wanted: reqText } });
        ask("CONFIRM_DIFFERENCE", { field: "paymentTerms", item: "", quoted: text, wanted: reqText });
      } else if (got.balanceTiming === null || want.balanceTiming === null) termRow("paymentTerms", reqText, pt.views, "OPEN", { code: "PARTIAL_TERMS", args: {} });
      else termRow("paymentTerms", reqText, pt.views, "MATCH", { code: "MATCH", args: {} });
    }
  }

  // ---- fees ----
  const fees: FeeView[] = [];
  const feeSources: { origin: Origin; res: ExtractionResult }[] = [{ origin: self, res: result }, ...(isSupplement && base && baseResult ? [{ origin: base, res: baseResult }] : [])];
  for (const { origin, res } of feeSources) {
    const resTotal = usedValue<ExactMoney>(origin, "MONEY", "total", res.total).value;
    const prices = res.items.map((it, i) => usedValue<ExactMoney>(origin, "MONEY", `items[${i}].unitPrice`, it.unitPrice).value);
    const subtotals = res.items.map((it, i) => {
      const q = usedValue<number>(origin, "QUANTITY", `items[${i}].quantity`, it.quantity).value;
      return prices[i] && q !== null ? { currency: prices[i]!.currency, minor: prices[i]!.minor * BigInt(q) } : null;
    });
    res.fees.forEach((fee, i) => fees.push(feeView(origin, fee, i, resTotal, prices, subtotals)));
  }
  for (const f of fees) {
    const what = f.description.used ?? f.description.modelValue ?? `#${f.index + 1}`;
    if (f.status === "SUSPECTED_DUPLICATE") ask("CONFIRM_DUPLICATE", { fee: what });
    else if (f.status === "OPEN") ask("CLARIFY_FEE", { fee: what, reasons: f.reasons.join(",") });
  }

  // ---- cost overview (full quotes only; known amounts per currency, never a total cost) ----
  const cost: CostView = { computed: !isSupplement, lines: [], openCount: 0, duplicateCount: 0, complete: false, paymentAmount: null };
  cost.openCount = fees.filter((f) => f.status === "OPEN").length;
  cost.duplicateCount = fees.filter((f) => f.status === "SUSPECTED_DUPLICATE").length;
  if (!isSupplement) {
    const lines = new Map<QuoteCurrency, { stated: bigint | null; sum: bigint | null; extra: bigint; count: number }>();
    const line = (c: QuoteCurrency) => {
      if (!lines.has(c)) lines.set(c, { stated: null, sum: null, extra: ZERO, count: 0 });
      return lines.get(c)!;
    };
    if (total.value) line(total.value.currency).stated = total.value.minor;
    if (sumOfLines) line(sumOfLines.currency).sum = sumOfLines.minor;
    for (const f of fees) {
      if (f.status !== "KNOWN_EXTRA") continue;
      const m = readMoney(f.amount.used!)!;
      const l = line(m.currency);
      l.extra += m.minor;
      l.count += 1;
    }
    cost.lines = [...lines.entries()].map(([currency, l]) => ({
      currency,
      statedGoodsTotal: l.stated === null ? null : formatMinor(l.stated),
      sumOfItemLines: l.sum === null ? null : formatMinor(l.sum),
      knownExtras: formatMinor(l.extra),
      knownExtraCount: l.count,
    }));
  }

  // ---- summary ----
  const allViews = [...rows.flatMap((r) => r.quote), ...fees.flatMap((f) => [f.kind, f.amount, f.basis, f.included, f.statedAs])];
  const distinct = new Map(allViews.filter((v) => v.modelValue !== null || v.review !== "PENDING").map((v) => [`${v.runId}:${v.path}`, v] as const));
  const values = [...distinct.values()];
  const summary: Comparison["summary"] = {
    differences: rows.filter((r) => r.outcome === "DIFFERENCE").length,
    // Open rows + open or duplicate fees + inherited terms of a supplement that cannot be resolved (item lines are already rows).
    open: rows.filter((r) => r.outcome === "OPEN").length + cost.openCount + cost.duplicateCount + new Set(unresolved.filter((u) => !u.startsWith("item:"))).size,
    matches: rows.filter((r) => r.outcome === "MATCH").length,
    valuesUsed: values.length,
    confirmed: values.filter((v) => v.review === "CONFIRMED").length,
    corrected: values.filter((v) => v.review === "CORRECTED").length,
    pending: values.filter((v) => v.review === "PENDING").length,
    rejected: values.filter((v) => v.review === "REJECTED").length,
    pairsConfirmed: paired.filter((p) => p.pairing.status === "CONFIRMED").length,
    pairsProposed: paired.filter((p) => p.pairing.status === "PROPOSED").length,
    pairsOpen: paired.filter((p) => p.pairing.status === "NEEDS_CHOICE" || p.pairing.status === "CONFLICT").length,
  };

  const order: Record<Outcome, number> = { DIFFERENCE: 0, OPEN: 1, MATCH: 2 };
  return {
    binding: {
      comparatorVersion: COMPARATOR_VERSION,
      asOf: input.asOf,
      requestId: version.requestId,
      snapshotRevision: version.requestRevision,
      currentRequestRevision: input.currentRequestRevision,
      requestUpdated: input.currentRequestRevision !== null && input.currentRequestRevision !== version.requestRevision,
      version: { id: version.id, versionNumber: version.versionNumber, latestVersionNumber: version.latestVersionNumber, contentKind: version.contentKind, rawTextSha256: version.rawTextSha256 },
      run: { id: run.id, mode: run.mode, provider: run.provider, model: run.model, promptVersion: run.promptVersion, checkRules: checkRulesOf(result), status: run.status, startedAt: run.startedAt },
      base: input.base
        ? {
            versionId: input.base.version.id,
            versionNumber: input.base.version.versionNumber,
            rawTextSha256: input.base.version.rawTextSha256,
            snapshotRevision: input.base.version.requestRevision,
            run: baseRun ? { id: baseRun.id, mode: baseRun.mode, model: baseRun.model, checkRules: checkRulesOf(baseRun.result!), startedAt: baseRun.startedAt } : null,
          }
        : null,
    },
    pairings: paired.map((p) => p.pairing),
    requestLines: snapshot.items.map((i) => ({ id: i.id, position: i.position, name: i.name, quantity: i.quantity, unit: i.unit })),
    rows: rows.map((r, i) => ({ r, i })).sort((a, b) => order[a.r.outcome] - order[b.r.outcome] || a.i - b.i).map(({ r }) => r),
    fees,
    cost,
    questions,
    unresolvedInheritance: [...new Set(unresolved)],
    inheritance,
    summary,
    use: "DISCREPANCIES_AND_QUESTIONS_ONLY",
  };
}

type Push = (field: RowField, requestText: string | null, q: QuoteValue, outcome: Outcome, note: Note) => void;
type Asker = (field: string, outcome: Outcome, args: Record<string, string>) => void;

function compareItem(line: ProcurementItem, item: ExtractionResult["items"][number], origin: Origin, index: number, push: Push, missing: (q: QuoteValue) => Note, asker: Asker): void {
  // Quantity (with unit wording).
  const qty = usedValue<number>(origin, "QUANTITY", `items[${index}].quantity`, item.quantity);
  const unit = usedValue<string>(origin, "TEXT", `items[${index}].unit`, item.unit);
  const reqQty = line.quantity === null ? null : `${line.quantity}${line.unit ? ` ${line.unit}` : ""}`;
  if (line.quantity !== null || qty.value !== null) {
    if (line.quantity === null) {
      push("quantity", null, qty.view, "OPEN", { code: "REQUEST_WORDING_NOT_RECOGNISED", args: {} });
    } else if (qty.value === null) {
      push("quantity", reqQty, qty.view, "OPEN", missing(qty.view));
      asker("quantity", "OPEN", {});
    } else if (qty.value !== line.quantity) {
      push("quantity", reqQty, qty.view, "DIFFERENCE", { code: "DIFFERENT", args: { quoted: String(qty.value), wanted: String(line.quantity) } });
      asker("quantity", "DIFFERENCE", { quoted: `${qty.value}${unit.value ? ` ${unit.value}` : ""}`, wanted: reqQty! });
    } else if (line.unit && unit.value && unitKey(line.unit) !== unitKey(unit.value)) {
      push("quantity", reqQty, qty.view, "OPEN", { code: "UNIT_DIFFERS", args: { quoted: unit.value, wanted: line.unit } });
      asker("unit", "OPEN", { quoted: unit.value, wanted: line.unit });
    } else push("quantity", reqQty, qty.view, "MATCH", { code: "MATCH", args: {} });
  }

  // Unit price: the request has none to compare with, but an unknown price is an open point (never 0).
  const price = usedValue<ExactMoney>(origin, "MONEY", `items[${index}].unitPrice`, item.unitPrice);
  if (price.value === null) {
    push("unitPrice", null, price.view, "OPEN", missing(price.view));
    asker("unitPrice", "OPEN", {});
  }

  // Material grade.
  if (line.material) {
    const mat = usedValue<string>(origin, "TEXT", `items[${index}].material`, item.material);
    const want = parseMaterialGrade(line.material);
    if (mat.value === null) {
      push("material", line.material, mat.view, "OPEN", missing(mat.view));
      asker("material", "OPEN", {});
    } else if (want === null) push("material", line.material, mat.view, "OPEN", { code: "REQUEST_WORDING_NOT_RECOGNISED", args: {} });
    else {
      const got = parseMaterialGrade(mat.value);
      if (got === null) {
        push("material", line.material, mat.view, "OPEN", { code: "QUOTE_WORDING_NOT_RECOGNISED", args: {} });
        asker("material", "OPEN", {});
      } else if (got !== want) {
        push("material", line.material, mat.view, "DIFFERENCE", { code: "DIFFERENT", args: { quoted: got, wanted: want } });
        asker("material", "DIFFERENCE", { quoted: mat.value, wanted: line.material });
      } else push("material", line.material, mat.view, "MATCH", { code: "MATCH", args: {} });
    }
  }

  // Logo / customisation.
  if (line.customization) {
    const logo = usedValue<string>(origin, "TEXT", `items[${index}].logo`, item.logo);
    const want = parseLogo(line.customization);
    if (logo.value === null) {
      push("logo", line.customization, logo.view, "OPEN", missing(logo.view));
      asker("logo", "OPEN", {});
    } else if (want === null) push("logo", line.customization, logo.view, "OPEN", { code: "REQUEST_WORDING_NOT_RECOGNISED", args: {} });
    else {
      const got = parseLogo(logo.value);
      const differs = got !== null && ((want.method !== null && got.method !== null && got.method !== want.method) || (want.colours !== null && got.colours !== null && got.colours !== want.colours));
      const partial = got === null || (want.method !== null && got.method === null) || (want.colours !== null && got.colours === null);
      if (differs) {
        push("logo", line.customization, logo.view, "DIFFERENCE", { code: "DIFFERENT", args: { quoted: logo.value, wanted: line.customization } });
        asker("logo", "DIFFERENCE", { quoted: logo.value, wanted: line.customization });
      } else if (partial) {
        push("logo", line.customization, logo.view, "OPEN", { code: "QUOTE_WORDING_NOT_RECOGNISED", args: {} });
        asker("logo", "OPEN", {});
      } else push("logo", line.customization, logo.view, "MATCH", { code: "MATCH", args: {} });
    }
  }

  // Specification: free text on both sides — shown side by side, never judged by code.
  if (line.specification) {
    const spec = usedValue<string>(origin, "TEXT", `items[${index}].specification`, item.specification);
    if (spec.value === null) push("specification", line.specification, spec.view, "OPEN", missing(spec.view));
    else push("specification", line.specification, spec.view, "OPEN", { code: "FREE_TEXT", args: {} });
  }
}

const AMOUNT_BASES = ["PER_UNIT", "LUMP_SUM"] as const;

function feeView(origin: Origin, fee: FeeLine, index: number, total: ExactMoney | null, prices: (ExactMoney | null)[], subtotals: (ExactMoney | null)[]): FeeView {
  const p = `fees[${index}]`;
  const kind = usedValue<string>(origin, FEE_KINDS, `${p}.kind`, fee.kind);
  const description = usedValue<string>(origin, "TEXT", `${p}.description`, fee.description);
  const amount = usedValue<ExactMoney>(origin, "MONEY", `${p}.amount`, fee.amount);
  const basis = usedValue<string>(origin, AMOUNT_BASES, `${p}.amountBasis`, fee.amountBasis);
  const included = usedValue<string>(origin, INCLUDED_VALUES, `${p}.includedInQuote`, fee.includedInQuote);
  const statedAs = usedValue<string>(origin, FEE_STATED_AS, `${p}.statedAs`, fee.statedAs);
  const payer = usedValue<string>(origin, "TEXT", `${p}.payer`, fee.payer);
  const reasons: FeeReason[] = [];
  let status: FeeStatus;
  const same = (a: ExactMoney | null, b: ExactMoney | null) => a !== null && b !== null && a.currency === b.currency && a.minor === b.minor;
  // GOODS lines: the goods are already in the items and the total. Flagged, never added, never deleted.
  if (kind.value === "GOODS") {
    status = "SUSPECTED_DUPLICATE";
    if (same(amount.value, total)) reasons.push("GOODS_EQUALS_TOTAL");
    else if (prices.some((x) => same(amount.value, x))) reasons.push("GOODS_EQUALS_ITEM_PRICE");
    else if (subtotals.some((x) => same(amount.value, x))) reasons.push("GOODS_EQUALS_LINE");
    else reasons.push("GOODS_REPEAT");
  } else if (statedAs.value === "NOT_APPLICABLE") status = "NOT_APPLICABLE";
  else if (included.value === "INCLUDED") status = "INCLUDED";
  else {
    if (amount.value === null) reasons.push(amount.view.check === "NOT_STATED" && amount.view.review === "PENDING" ? "AMOUNT_NOT_STATED" : "AMOUNT_OR_CURRENCY_UNCLEAR");
    if (included.value === null) reasons.push("INCLUSION_UNKNOWN");
    if (statedAs.value !== "FIRM") reasons.push("NOT_FIRM");
    if (basis.value === "PER_UNIT") reasons.push("PER_UNIT_NOT_ALLOCATED");
    else if (basis.value !== "LUMP_SUM" && amount.value !== null) reasons.push("BASIS_UNKNOWN");
    status = reasons.length === 0 ? "KNOWN_EXTRA" : "OPEN";
  }
  return {
    index,
    source: origin.source,
    versionNumber: origin.versionNumber,
    status,
    reasons,
    kind: kind.view,
    description: description.view,
    amount: amount.view,
    basis: basis.view,
    included: included.view,
    statedAs: statedAs.view,
    payer: payer.view,
  };
}

/**
 * For the later approval step (29–30 Oct): the rows whose every quote value was confirmed or corrected
 * by the user AND that match the request. Model-only (pending) values never appear here, and no amount
 * from this list is a payment amount by itself.
 */
export function userConfirmedMatches(c: Comparison): ComparisonRow[] {
  return c.rows.filter((r) => r.outcome === "MATCH" && !r.provisionalPairing && r.quote.length > 0 && r.quote.every((q) => q.usedFrom === "USER_CONFIRMED" || q.usedFrom === "USER_CORRECTED"));
}
