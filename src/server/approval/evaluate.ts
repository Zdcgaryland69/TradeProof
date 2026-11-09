// Approval gate and condition snapshot (29 Oct; design docs/approval-design.md §2–§6).
//
// Pure apart from hashing: every input is read from stored records by the service and passed in. Nothing here calls a
// model, PayPal or the network, and nothing comes from the browser except which ids to evaluate.
//
// Levels: BLOCK (approval impossible) · CONFIRM (allowed only after the user confirms this exact item; used only where
// the quote itself gives evidence) · INFO (shown). A blocking item cannot be offset by passes. A buyer statement can add
// BLOCK or CONFIRM but never turns anything into ALLOW, and no value or amount ever comes from a statement.

import { createHash } from "node:crypto";
import {
  COMPARATOR_VERSION,
  looksNotAgreed,
  readAmount,
  readCurrency,
  readMoney,
  readQuantity,
  showMoney,
  usedValue,
  type Comparison,
  type ExactMoney,
  type FeeView,
  type Origin,
  type QuoteValue,
} from "../../lib/comparison.ts";
import { CURRENT_CHECK_RULES, FEE_PARTIES, type ExtractionResult, type ExtractionReview, type ExtractionRun } from "../../lib/extraction.ts";
import { shortItemRef, shortProcurementId, type ProcurementRecord } from "../../lib/procurement.ts";
import { parseLogo, parsePaymentTerms } from "../../lib/quote.ts";
import { REPLY_RULES, type StatementKind } from "../../lib/replies.ts";
import { shortSeriesId } from "../../lib/quote-versions.ts";
import { minorDigits } from "../payments/money.ts";

export const APPROVAL_RULES = "approval-rules-2026-10-29.2";
export const SNAPSHOT_FORMAT = "approval-snapshot-1";
export const DIGEST_FORMAT = "approval-digest-1";
/** Technical upper limit for one Sandbox payment (USD 100.00). Not an approval or a payment authorisation. */
export const SANDBOX_CEILING_MINOR = 10_000;

export type Level = "BLOCK" | "CONFIRM" | "INFO";
export interface Finding {
  level: Level;
  code: string;
  /** What it is about (line id, field, fee index, answer id …); part of the confirmation key. */
  subject: string;
  args: Record<string, string>;
  /** `code:<hash of subject + args>` — a confirmation is bound to this exact content. */
  key: string;
}

export interface VersionBasis {
  id: string;
  seriesId: string;
  versionNumber: number;
  contentKind: "FULL_QUOTE" | "SUPPLEMENT";
  supplementsVersionId: string | null;
  rawText: string;
  rawTextSha256: string;
  computedSha256: string;
  requestRevision: number;
  snapshotRecord: Omit<ProcurementRecord, "buyerType" | "buyerPersonName"> & Partial<Pick<ProcurementRecord, "buyerType" | "buyerPersonName">>;
}

export interface SeriesStatement {
  answerId: string;
  draftId: string;
  number: number;
  field: string;
  requestItemId: string | null;
  itemName: string | null;
  statement: string;
  kind: StatementKind | null;
  quoteUpdate: "NONE" | "UPDATED_QUOTE_NEEDED" | "MANUAL_REVIEW";
  supplierReplyId: string;
  contradicted: boolean;
  basisChanges: string[];
  /** Quote versions the user linked this statement's reply to as "the updated quote". */
  linkedVersionIds: string[];
}

export interface Classification {
  id: string;
  subject: string;
  textSha256: string;
  decision: "NOT_KEY" | "KEY_IN_QUOTE" | "KEY_NOT_IN_QUOTE";
  reason: string;
  excerpt: string | null;
  excerptVersionId: string | null;
}

export interface PriorPayment {
  approvalId: string;
  recordId: string;
  status: string;
}

export interface EvaluationInput {
  request: ProcurementRecord;
  version: VersionBasis;
  base: VersionBasis | null;
  seriesVersions: { id: string; versionNumber: number; contentKind: string; supplementsVersionId: string | null }[];
  run: ExtractionRun;
  baseRun: ExtractionRun | null;
  reviews: ExtractionReview[];
  baseReviews: ExtractionReview[];
  /** null when the comparison was refused (code in `refusal`). */
  comparison: Comparison | null;
  refusal: string | null;
  statements: SeriesStatement[];
  /** Latest classification per subject for this version. */
  classifications: Classification[];
  priorPayments: PriorPayment[];
  payee: { configured: boolean; fingerprint: string | null };
  ceilingMinor?: number;
  asOf: string;
}

export interface SnapshotValue {
  value: string | null;
  origin: "USER_CONFIRMED" | "USER_CORRECTED" | "MODEL" | null;
  review: string;
  reviewId: string | null;
  source: string;
  versionNumber: number;
  modelValue: string | null;
  excerpt: string | null;
}

export interface FeeEntry {
  source: string;
  versionNumber: number;
  index: number;
  kind: string | null;
  description: string | null;
  amount: string | null;
  amountReviewed: boolean;
  statedAs: string | null;
  basis: string | null;
  payer: string | null;
  payee: string | null;
  included: string | null;
}

export interface ApprovalSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  rules: { approval: string; comparator: string; checkRules: string; replies: string };
  asOf: string;
  request: { id: string; ref: string; revision: number; fingerprint: string; quoteSnapshotRevision: number; baseSnapshotRevision: number | null };
  quote: {
    seriesId: string;
    seriesRef: string;
    versionId: string;
    versionNumber: number;
    latestVersionNumber: number;
    contentKind: string;
    rawTextSha256: string;
    base: null | { versionId: string; versionNumber: number; rawTextSha256: string };
  };
  runs: { run: RunView; base: RunView | null };
  digests: { reviews: string; statements: string; classifications: string };
  items: {
    requestItemId: string;
    itemRef: string;
    name: string;
    request: { quantity: number | null; unit: string | null; material: string | null; specification: string | null; customization: string | null; notes: string | null };
    quote: { source: string; versionNumber: number; index: number; quantity: SnapshotValue; unit: SnapshotValue; unitPrice: SnapshotValue; lineSubtotal: string | null; material: SnapshotValue | null; specification: SnapshotValue | null; logo: SnapshotValue | null };
  }[];
  terms: { currency: SnapshotValue | null; total: SnapshotValue | null; paymentTerms: SnapshotValue | null; leadTime: SnapshotValue | null; incoterm: SnapshotValue | null };
  money: {
    goodsSubtotal: string | null;
    statedTotal: string | null;
    thisPayment: null | { currency: string; minor: number; display: string; basis: "FULL_STATED_TOTAL" };
    included: FeeEntry[];
    notApplicable: FeeEntry[];
    duplicates: FeeEntry[];
    excluded: FeeEntry[];
    unknown: FeeEntry[];
    unverified: FeeEntry[];
    landedCost: "NOT_CALCULATED_IN_THIS_VERSION";
  };
  statements: { answerId: string; number: number; field: string; kind: string; quoteUpdate: string; linkedToThisVersion: boolean; statement: string }[];
  classifications: { id: string; subject: string; decision: string; reason: string; excerpt: string | null }[];
  payee: { kind: "FIXED_SANDBOX_TEST_MERCHANT"; fingerprint: string | null };
  environment: "PAYPAL_SANDBOX";
  findings: Finding[];
}

interface RunView {
  id: string;
  mode: string;
  provider: string;
  model: string;
  status: string;
  checkRules: string | null;
}

export interface Evaluation {
  status: "BLOCKED" | "READY" | "READY_WITH_CONFIRMATIONS";
  findings: Finding[];
  snapshot: ApprovalSnapshot;
  digest: string;
  amount: { minor: number; currency: string } | null;
  confirmKeys: string[];
}

// ---------- hashing and canonical form ----------

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Sorted keys, arrays in their (defined) order, no floating point in money. Same data → same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("canonical form allows integers only");
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The request without what cannot change the approval terms (title, timestamps, data source, revision counter). */
export function requestFingerprint(record: VersionBasis["snapshotRecord"] | ProcurementRecord): string {
  const items = [...record.items].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  return sha256(
    canonicalJson({
      id: record.id,
      buyerType: record.buyerType ?? null,
      buyerPersonName: record.buyerPersonName ?? null,
      buyerCompany: record.buyerCompany,
      supplierName: record.supplierName,
      shipFrom: record.shipFrom,
      shipTo: record.shipTo,
      budgetCurrency: record.budgetCurrency,
      budgetMaxMinor: record.budgetMaxMinor,
      requiredShipDate: record.requiredShipDate,
      expectedDeliveryDate: record.expectedDeliveryDate,
      paymentTerms: record.paymentTerms,
      additionalRequirements: record.additionalRequirements,
      items: items.map((i) => ({ id: i.id, position: i.position, name: i.name, quantity: i.quantity, unit: i.unit, material: i.material, specification: i.specification, customization: i.customization, notes: i.notes })),
    }),
  );
}

export const reviewsDigest = (reviews: readonly ExtractionReview[]) => sha256(canonicalJson(reviews.map((r) => r.id).sort()));
export const statementsDigest = (s: readonly SeriesStatement[]) =>
  sha256(canonicalJson([...s].sort((a, b) => (a.answerId < b.answerId ? -1 : 1)).map((x) => ({ a: x.answerId, k: x.kind, q: x.quoteUpdate, c: x.contradicted, l: [...x.linkedVersionIds].sort() }))));
export const classificationsDigest = (c: readonly Classification[]) => sha256(canonicalJson(c.map((x) => x.id).sort()));
export const rulesKey = () => canonicalJson({ approval: APPROVAL_RULES, comparator: COMPARATOR_VERSION, checkRules: CURRENT_CHECK_RULES, replies: REPLY_RULES });

// ---------- evidence for user corrections ----------

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const NUMBER_TOKENS = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g;

/**
 * A correction of a critical value counts only with valid quote evidence: the field's excerpt was located in the
 * stored quote text, and the corrected value itself appears in that excerpt (numbers compared exactly as numbers,
 * text as normalised text). Codes read by interpretation (payee, inclusion, kind) need the located excerpt.
 * Otherwise it is the buyer's statement without basis and cannot become an approval condition.
 */
export function correctionHasEvidence(v: QuoteValue, kind: "MONEY" | "QUANTITY" | "CURRENCY" | "TEXT" | "CODE"): boolean {
  if (v.review !== "CORRECTED") return true;
  if (!v.evidence || v.correctionText === null || v.usedFrom !== "USER_CORRECTED") return false;
  const excerpt = v.evidence.excerpt;
  const numbers = [...excerpt.normalize("NFKC").matchAll(NUMBER_TOKENS)].map((m) => readAmount(m[0])).filter((x): x is bigint => x !== null);
  switch (kind) {
    case "MONEY": {
      const m = readMoney(v.correctionText);
      return m !== null && numbers.includes(m.minor) && readCurrencyIn(excerpt, m.currency);
    }
    case "QUANTITY": {
      const q = readQuantity(v.correctionText);
      return q !== null && numbers.includes(BigInt(q) * BigInt(100));
    }
    case "CURRENCY": {
      const c = readCurrency(v.correctionText);
      return c !== null && readCurrencyIn(excerpt, c);
    }
    case "TEXT":
      return norm(excerpt).includes(norm(v.correctionText));
    case "CODE":
      return true;
  }
}

function readCurrencyIn(excerpt: string, currency: string): boolean {
  const words: Record<string, RegExp> = { USD: /USD|US\$/i, SGD: /SGD|S\$/i, CNY: /CNY|RMB|人民币/i };
  return words[currency]?.test(excerpt.normalize("NFKC")) ?? false;
}

// ---------- evaluation ----------

const reviewedValue = (v: QuoteValue) => v.usedFrom === "USER_CONFIRMED" || v.usedFrom === "USER_CORRECTED";

function snap(v: QuoteValue): SnapshotValue {
  return { value: v.used, origin: v.usedFrom, review: v.review, reviewId: v.reviewId, source: v.source, versionNumber: v.versionNumber, modelValue: v.modelValue, excerpt: v.evidence?.excerpt ?? null };
}

export function evaluateApproval(input: EvaluationInput): Evaluation {
  const findings: Finding[] = [];
  const add = (level: Level, code: string, subject: string, args: Record<string, string> = {}) => {
    findings.push({ level, code, subject, args, key: `${code}:${sha256(canonicalJson({ subject, args })).slice(0, 24)}` });
  };
  const { request, version, base, run, baseRun, comparison: c } = input;
  const ceiling = input.ceilingMinor ?? SANDBOX_CEILING_MINOR;
  const self: Origin = { run, reviews: input.reviews, source: "THIS_VERSION", versionNumber: version.versionNumber };
  const baseOrigin: Origin | null = base && baseRun ? { run: baseRun, reviews: input.baseReviews, source: "BASE_VERSION", versionNumber: base.versionNumber } : null;
  const originOf = (source: string) => (source === "BASE_VERSION" ? baseOrigin : self);
  const resultOf = (source: string): ExtractionResult | null => (source === "BASE_VERSION" ? (baseRun?.result ?? null) : run.result);

  /** A critical value: present, reviewed by the user, and a correction only with quote evidence. */
  const need = (v: QuoteValue | null, kind: Parameters<typeof correctionHasEvidence>[1], code: string, subject: string, args: Record<string, string> = {}): boolean => {
    if (!v || v.used === null || v.review === "REJECTED") {
      add("BLOCK", v && v.check === "NOT_STATED" && v.review === "PENDING" ? `${code}_NOT_STATED` : `${code}_NOT_REVIEWED`, subject, args);
      return false;
    }
    if (!reviewedValue(v)) {
      add("BLOCK", `${code}_NOT_REVIEWED`, subject, args);
      return false;
    }
    if (v.review === "CORRECTED") {
      if (!correctionHasEvidence(v, kind)) {
        add("BLOCK", "CORRECTION_WITHOUT_EVIDENCE", subject, { ...args, field: code, correction: v.correctionText ?? "", excerpt: v.evidence?.excerpt ?? "" });
        return false;
      }
      add("CONFIRM", "USES_CORRECTION", subject, { ...args, field: code, correction: v.correctionText ?? "", original: v.modelValue ?? "", excerpt: v.evidence!.excerpt });
    }
    return true;
  };

  // ---- basis ----
  if (version.computedSha256 !== version.rawTextSha256) add("BLOCK", "TEXT_HASH_MISMATCH", version.id);
  if (base && base.computedSha256 !== base.rawTextSha256) add("BLOCK", "TEXT_HASH_MISMATCH", base.id);
  const latest = Math.max(...input.seriesVersions.map((v) => v.versionNumber));
  if (version.versionNumber !== latest) add("BLOCK", "NOT_LATEST_VERSION", version.id, { version: String(version.versionNumber), latest: String(latest) });
  const currentFp = requestFingerprint(request);
  const versionFp = requestFingerprint(version.snapshotRecord);
  if (versionFp !== currentFp || (base && requestFingerprint(base.snapshotRecord) !== currentFp)) {
    add("BLOCK", "REQUEST_CHANGED_SINCE_QUOTE", request.id, { quoteRevision: String(version.requestRevision), current: String(request.revision) });
  } else if (version.requestRevision !== request.revision) {
    add("INFO", "REQUEST_TITLE_ONLY", request.id, { quoteRevision: String(version.requestRevision), current: String(request.revision) });
  }
  if (version.contentKind === "SUPPLEMENT") {
    const baseRow = input.seriesVersions.find((v) => v.id === version.supplementsVersionId);
    if (!baseRow || !base) add("BLOCK", "SUPPLEMENT_BASE_MISSING", version.id);
    else {
      if (baseRow.contentKind !== "FULL_QUOTE") add("BLOCK", "SUPPLEMENT_CHAIN", version.id, { base: String(baseRow.versionNumber) });
      const skipped = input.seriesVersions.filter((v) => v.contentKind === "FULL_QUOTE" && v.versionNumber > baseRow.versionNumber && v.versionNumber < version.versionNumber);
      if (skipped.length > 0) add("BLOCK", "SUPPLEMENT_SKIPS_NEWER_FULL", version.id, { base: String(baseRow.versionNumber), newer: skipped.map((v) => String(v.versionNumber)).join(", ") });
      if (!baseRun) add("BLOCK", "SUPPLEMENT_BASE_RUN_MISSING", version.id);
    }
  }
  if (input.refusal) add("BLOCK", "RUN_NOT_USABLE", run.id, { reason: input.refusal });
  if (run.mode === "MOCK" || baseRun?.mode === "MOCK") add("INFO", "MOCK_RUN", run.id);
  if (!input.payee.configured || !input.payee.fingerprint) add("BLOCK", "PAYEE_NOT_CONFIGURED", "payee");
  add("INFO", "PAYEE_IS_SANDBOX_TEST_MERCHANT", "payee");
  add("INFO", "NOT_A_PAYMENT_AUTHORISATION", "approval");
  for (const p of input.priorPayments) {
    if (p.status === "PAID") add("BLOCK", "ALREADY_PAID", p.recordId, { approval: p.approvalId });
    else if (["ORDER_CREATING", "CAPTURING", "CAPTURE_UNKNOWN", "CAPTURE_PENDING", "NEEDS_REVIEW"].includes(p.status)) add("BLOCK", "PAYMENT_OUTCOME_OPEN", p.recordId, { approval: p.approvalId, status: p.status });
  }

  const items: ApprovalSnapshot["items"] = [];
  const terms: ApprovalSnapshot["terms"] = { currency: null, total: null, paymentTerms: null, leadTime: null, incoterm: null };
  const money: ApprovalSnapshot["money"] = { goodsSubtotal: null, statedTotal: null, thisPayment: null, included: [], notApplicable: [], duplicates: [], excluded: [], unknown: [], unverified: [], landedCost: "NOT_CALCULATED_IN_THIS_VERSION" };
  let amount: { minor: number; currency: string } | null = null;

  if (c) {
    if (c.unresolvedInheritance.length > 0) add("BLOCK", "SUPPLEMENT_INHERITANCE_UNRESOLVED", version.id, { fields: c.unresolvedInheritance.join(", ") });
    const lines = new Map(version.snapshotRecord.items.map((l) => [l.id, l] as const));

    // ---- items ----
    for (const p of c.pairings) {
      const subject = `${p.source}:${p.quoteItemIndex}`;
      const label = p.quoteItemName ?? `#${p.quoteItemIndex + 1}`;
      if (p.status === "NO_MATCH_BY_USER") {
        add("BLOCK", "EXTRA_QUOTE_ITEM", subject, { item: label });
        continue;
      }
      if (p.status !== "CONFIRMED" || !p.requestItemId) {
        add("BLOCK", "PAIRING_NOT_CONFIRMED", subject, { item: label, status: p.status });
        continue;
      }
      const line = lines.get(p.requestItemId);
      const origin = originOf(p.source);
      const res = resultOf(p.source);
      if (!line || !origin || !res) {
        add("BLOCK", "PAIRING_NOT_CONFIRMED", subject, { item: label, status: "LINE_MISSING" });
        continue;
      }
      const lineSubject = `${line.id}:${subject}`;
      const lineArgs = { item: line.name };
      const rows = c.rows.filter((r) => r.requestItemId === line.id && r.quoteItemIndex === p.quoteItemIndex);
      const row = (field: string) => rows.find((r) => r.field === field) ?? null;
      const it = res.items[p.quoteItemIndex];
      const qtyView = usedValue<number>(origin, "QUANTITY", `items[${p.quoteItemIndex}].quantity`, it.quantity).view;
      const unitView = usedValue<string>(origin, "TEXT", `items[${p.quoteItemIndex}].unit`, it.unit).view;

      // Quantity and unit.
      const qRow = row("quantity");
      if (line.quantity === null) add("BLOCK", "REQUEST_QUANTITY_MISSING", lineSubject, lineArgs);
      else if (qRow?.outcome === "DIFFERENCE") add("BLOCK", "QTY_DIFFERS", lineSubject, { ...lineArgs, quoted: qRow.note.args.quoted ?? "", wanted: qRow.note.args.wanted ?? "" });
      else if (qRow?.note.code === "UNIT_DIFFERS") add("BLOCK", "UNIT_DIFFERS", lineSubject, { ...lineArgs, quoted: qRow.note.args.quoted ?? "", wanted: qRow.note.args.wanted ?? "" });
      else need(qtyView, "QUANTITY", "QTY", lineSubject, lineArgs);
      if (line.unit) need(unitView, "TEXT", "UNIT", lineSubject, lineArgs);
      need(p.unitPrice, "MONEY", "PRICE", lineSubject, lineArgs);

      // Key attributes = what the buyer required on this line (the comparator makes a row only for those).
      const attr = (field: "material" | "logo" | "specification", required: string | null): SnapshotValue | null => {
        const r = row(field);
        if (!required) return r ? snap(r.quote[0]) : null;
        const v = r?.quote[0] ?? null;
        const args = { ...lineArgs, field, required };
        const subj = `${lineSubject}:${field}`;
        if (!r || !v || v.used === null || v.review === "REJECTED") {
          add("BLOCK", "KEY_ATTRIBUTE_NOT_QUOTED", subj, args);
          return v ? snap(v) : null;
        }
        if (r.outcome === "DIFFERENCE") {
          add("BLOCK", "KEY_ATTRIBUTE_DIFFERS", subj, { ...args, quoted: v.used });
          return snap(v);
        }
        if (field === "logo" && r.note.code === "QUOTE_WORDING_NOT_RECOGNISED") {
          const want = parseLogo(required);
          const got = parseLogo(v.used);
          // The quote states only part of the requirement (e.g. the method but not the required colours).
          if (got !== null && want !== null && ((want.method !== null && got.method === null) || (want.colours !== null && got.colours === null))) {
            add("BLOCK", "KEY_ATTRIBUTE_NOT_QUOTED", subj, { ...args, partial: v.used });
            return snap(v);
          }
        }
        if (!reviewedValue(v)) {
          add("BLOCK", "KEY_ATTRIBUTE_NOT_REVIEWED", subj, args);
          return snap(v);
        }
        if (!need(v, "TEXT", "KEY_ATTRIBUTE", subj, args)) return snap(v);
        if (r.outcome !== "MATCH") add("CONFIRM", "KEY_ATTRIBUTE_BY_EYE", subj, { ...args, quoted: v.used, excerpt: v.evidence?.excerpt ?? "" });
        return snap(v);
      };
      const material = attr("material", line.material);
      const logo = attr("logo", line.customization);
      const specification = attr("specification", line.specification);
      items.push({
        requestItemId: line.id,
        itemRef: shortItemRef(line.id),
        name: line.name,
        request: { quantity: line.quantity, unit: line.unit, material: line.material, specification: line.specification, customization: line.customization, notes: line.notes },
        quote: { source: p.source, versionNumber: origin.versionNumber, index: p.quoteItemIndex, quantity: snap(qtyView), unit: snap(unitView), unitPrice: snap(p.unitPrice), lineSubtotal: p.lineSubtotal, material, specification, logo },
      });
    }
    for (const r of c.rows) if (r.field === "pairing" && r.quoteItemIndex === null && r.note.code === "NOT_QUOTED") add("BLOCK", "REQUEST_LINE_NOT_QUOTED", r.requestItemId ?? "", { item: r.requestText ?? "" });
    items.sort((a, b) => (lines.get(a.requestItemId)!.position - lines.get(b.requestItemId)!.position) || a.quote.index - b.quote.index);

    // ---- request-level terms (a supplement's value or, when it does not restate one, its base's) ----
    const termView = (key: "currency" | "total" | "incoterm" | "leadTime" | "paymentTerms", kind: "CURRENCY" | "MONEY" | "TEXT"): QuoteValue | null => {
      if (version.contentKind === "SUPPLEMENT") {
        const e = c.inheritance.find((x) => x.field === key);
        return !e || e.status === "UNRESOLVED" ? null : e.views[0];
      }
      return usedValue<unknown>(self, kind, key, run.result![key]).view;
    };
    const termRow = (field: string) => c.rows.find((r) => r.key === `term-${field}`) ?? null;

    // Currency and amounts.
    const curView = termView("currency", "CURRENCY");
    terms.currency = curView ? snap(curView) : null;
    if (termRow("currency")?.note.code === "SEVERAL_CURRENCIES") add("BLOCK", "SEVERAL_CURRENCIES", "currency", { list: termRow("currency")!.note.args.list ?? "" });
    if (curView && curView.modelValue !== null) need(curView, "CURRENCY", "CURRENCY", "currency");
    if (termRow("currency")?.note.code === "CURRENCY_DIFFERS") add("BLOCK", "BUDGET_NOT_COMPARABLE", "currency", { quoted: termRow("currency")!.note.args.quoted ?? "", wanted: termRow("currency")!.note.args.wanted ?? "" });
    const totalView = termView("total", "MONEY");
    terms.total = totalView ? snap(totalView) : null;
    const totalOk = need(totalView, "MONEY", "TOTAL", "total");
    const total = totalOk && totalView ? readMoney(totalView.used!) : null;
    money.statedTotal = total ? showMoney(total) : null;
    const arith = termRow("arithmetic");
    if (arith?.note.code === "TOTAL_MATCHES_LINES") money.goodsSubtotal = arith.note.args.sum ?? null;
    else if (arith?.note.code === "TOTAL_DIFFERS_FROM_LINES") add("BLOCK", "TOTAL_DIFFERS_FROM_LINES", "total", { sum: arith.note.args.sum ?? "", total: arith.note.args.total ?? "" });
    else add("BLOCK", "CANNOT_CHECK_TOTAL", "total");
    const budget = termRow("budget");
    if (budget?.note.code === "OVER_BUDGET") add("BLOCK", "OVER_BUDGET", "budget", { total: budget.note.args.total ?? "", budget: budget.note.args.budget ?? "" });
    else if (budget?.note.code === "BUDGET_OTHER_CURRENCY") add("BLOCK", "BUDGET_NOT_COMPARABLE", "budget", { quoted: budget.note.args.quoted ?? "", wanted: budget.note.args.wanted ?? "" });
    else if (request.budgetMaxMinor === null) add("INFO", "NO_BUDGET", "budget");
    if (total) {
      if (minorDigits(total.currency) === undefined) add("BLOCK", "CURRENCY_NOT_PAYABLE", "total", { currency: total.currency });
      else if (total.minor > BigInt(ceiling)) add("BLOCK", "ABOVE_SANDBOX_CEILING", "total", { total: showMoney(total), ceiling: showMoney({ currency: total.currency, minor: BigInt(ceiling) } as ExactMoney) });
      else amount = { minor: Number(total.minor), currency: total.currency };
    }

    // Payment terms: v1 pays the stated total once, in full.
    const ptView = termView("paymentTerms", "TEXT");
    terms.paymentTerms = ptView ? snap(ptView) : null;
    if (need(ptView, "TEXT", "PAYMENT_TERMS", "paymentTerms")) {
      const text = ptView!.used!;
      const parsed = parsePaymentTerms(text);
      if (looksNotAgreed(text) || !parsed) add("BLOCK", "TERMS_NOT_SETTLED", "paymentTerms", { text });
      else if (parsed.depositPercent < 100) add("BLOCK", "STAGED_PAYMENT", "paymentTerms", { text, deposit: String(parsed.depositPercent) });
      const ptRow = termRow("paymentTerms");
      if (ptRow?.outcome === "DIFFERENCE") add("BLOCK", "PAYMENT_TERMS_DIFFER", "paymentTerms", { quoted: text, wanted: request.paymentTerms ?? "" });
      else if (ptRow?.note.code === "REQUEST_WORDING_NOT_RECOGNISED") add("CONFIRM", "PAYMENT_TERMS_BY_EYE", "paymentTerms", { quoted: text, wanted: request.paymentTerms ?? "" });
    }

    // Lead time: with a deadline in the request, it must be verifiable; start-point or approximate wording blocks.
    const ltView = termView("leadTime", "TEXT");
    terms.leadTime = ltView ? snap(ltView) : null;
    const lt = termRow("leadTime");
    const deadline = request.requiredShipDate ?? request.expectedDeliveryDate;
    if (lt) {
      const code = lt.note.code;
      if (code === "LEAD_TIME_TOO_LATE") add("BLOCK", "LEAD_TIME_TOO_LATE", "leadTime", lt.note.args);
      else if (code === "LEAD_TIME_FITS") need(ltView, "TEXT", "LEAD_TIME", "leadTime");
      else add("BLOCK", "LEAD_TIME_UNVERIFIABLE", "leadTime", { reason: code, quoted: ltView?.used ?? "", deadline: deadline ?? "" });
    } else if (deadline) {
      add("BLOCK", "LEAD_TIME_UNVERIFIABLE", "leadTime", { reason: request.requiredShipDate ? "NOT_STATED" : "DELIVERY_DATE_ONLY", quoted: ltView?.used ?? "", deadline });
    } else add("INFO", "NO_DEADLINE", "leadTime", { quoted: ltView?.used ?? "" });

    // Trade term.
    const incView = termView("incoterm", "TEXT");
    terms.incoterm = incView ? snap(incView) : null;
    const inc = termRow("incoterm");
    if (inc) {
      const code = inc.note.code;
      if (code === "DIFFERENT") add("BLOCK", "INCOTERM_DIFFERS", "incoterm", inc.note.args);
      else if (code === "NOT_AGREED") add("BLOCK", "INCOTERM_NOT_SETTLED", "incoterm", inc.note.args);
      else if (code === "MATCH_APPROX_PLACE") need(incView, "TEXT", "INCOTERM", "incoterm");
      else if ((code === "QUOTE_WORDING_NOT_RECOGNISED" || code === "REQUEST_WORDING_NOT_RECOGNISED") && incView && incView.used !== null) {
        if (need(incView, "TEXT", "INCOTERM", "incoterm")) add("CONFIRM", "INCOTERM_BY_EYE", "incoterm", { quoted: incView.used, wanted: inc.requestText ?? "" });
      } else add("BLOCK", "INCOTERM_NOT_QUOTED", "incoterm", { wanted: inc.requestText ?? "" });
    } else add("INFO", "NO_INCOTERM", "incoterm");

    // ---- fees ----
    for (const f of c.fees) {
      const subject = `fee:${f.source}:${f.index}`;
      const res = resultOf(f.source);
      const origin = originOf(f.source);
      const raw = res?.fees[f.index];
      const payeeView = raw && origin ? usedValue<string>(origin, FEE_PARTIES, `fees[${f.index}].payee`, raw.payee).view : null;
      const entry: FeeEntry = {
        source: f.source,
        versionNumber: f.versionNumber,
        index: f.index,
        kind: f.kind.used,
        description: f.description.used ?? f.description.modelValue,
        amount: f.amount.used ?? f.amount.modelValue,
        amountReviewed: reviewedValue(f.amount),
        statedAs: f.statedAs.used ?? f.statedAs.modelValue,
        basis: f.basis.used ?? f.basis.modelValue,
        payer: f.payer.used,
        payee: payeeView?.used ?? null,
        included: f.included.used,
      };
      const args = { fee: entry.description ?? `#${f.index + 1}`, amount: entry.amount ?? "" };
      if (!need(f.kind, "CODE", "FEE_KIND", subject, args)) continue;
      if (f.status === "SUSPECTED_DUPLICATE") {
        if (f.reasons.includes("GOODS_REPEAT")) add("BLOCK", "GOODS_REPEAT_UNCLEAR", subject, args);
        else add("CONFIRM", "GOODS_REPEAT_EXACT", subject, { ...args, reason: f.reasons.join(",") });
        money.duplicates.push(entry);
        continue;
      }
      if (f.status === "NOT_APPLICABLE") {
        money.notApplicable.push(entry);
        continue;
      }
      if (!need(f.included, "CODE", "FEE_INCLUSION", subject, args)) continue;
      if (f.payer.used === "SUPPLIER") add("INFO", "FEE_BORNE_BY_SUPPLIER", subject, args);
      if (f.included.used === "INCLUDED") {
        money.included.push(entry);
        continue;
      }
      // Not included in the stated total: who receives it decides whether it could belong to this payment.
      if (!payeeView || payeeView.used === null) {
        add("BLOCK", "FEE_PAYEE_UNKNOWN", subject, args);
        continue;
      }
      if (!need(payeeView, "CODE", "FEE_PAYEE", subject, args)) continue;
      if (payeeView.used === "SUPPLIER") {
        add("BLOCK", "SUPPLIER_EXTRA_OUTSIDE_TOTAL", subject, args);
        continue;
      }
      const bucket = f.amount.used === null || f.payer.used === null ? "unknown" : reviewedValue(f.amount) && f.statedAs.used === "FIRM" && f.basis.used === "LUMP_SUM" ? "excluded" : "unverified";
      money[bucket].push(entry);
      add("CONFIRM", "OUTSIDE_THIS_PAYMENT", subject, { ...args, payee: payeeView.used, payer: f.payer.used ?? "UNKNOWN", bucket });
    }

    // ---- free-text requirements: the buyer classifies them (key or not) with a reason ----
    const subjects: { subject: string; text: string; label: string }[] = [];
    for (const l of version.snapshotRecord.items) if (l.notes) subjects.push({ subject: `ITEM_NOTES:${l.id}`, text: l.notes, label: l.name });
    if (version.snapshotRecord.additionalRequirements) subjects.push({ subject: "ADDITIONAL_REQUIREMENTS", text: version.snapshotRecord.additionalRequirements, label: "" });
    for (const s of subjects) {
      const cl = input.classifications.find((x) => x.subject === s.subject && x.textSha256 === sha256(s.text));
      const args = { subjectKind: s.subject === "ADDITIONAL_REQUIREMENTS" ? "ADDITIONAL" : "ITEM_NOTES", item: s.label, text: s.text };
      if (!cl) add("BLOCK", "REQUIREMENT_NOT_CLASSIFIED", s.subject, args);
      else if (cl.decision === "KEY_NOT_IN_QUOTE") add("BLOCK", "KEY_REQUIREMENT_NOT_QUOTED", s.subject, { ...args, reason: cl.reason });
      else if (cl.decision === "KEY_IN_QUOTE") {
        const texts = [version, base].filter((v): v is VersionBasis => v !== null && v.id === cl.excerptVersionId).map((v) => v.rawText);
        if (!cl.excerpt || !texts.some((t) => t.includes(cl.excerpt!))) add("BLOCK", "KEY_REQUIREMENT_NOT_QUOTED", s.subject, { ...args, reason: cl.reason });
        else add("INFO", "KEY_REQUIREMENT_IN_QUOTE", s.subject, { ...args, reason: cl.reason, excerpt: cl.excerpt });
      } else add("INFO", "REQUIREMENT_NOT_KEY", s.subject, { ...args, reason: cl.reason });
    }

    // ---- buyer statements on supplier replies of this series ----
    for (const s of input.statements) {
      const subject = `answer:${s.answerId}`;
      const args = { number: String(s.number), field: s.field, item: s.itemName ?? "", statement: s.statement };
      if (s.contradicted) add("BLOCK", "READINGS_CONFLICT", subject, args);
      if (s.quoteUpdate === "UPDATED_QUOTE_NEEDED") {
        if (!s.linkedVersionIds.includes(version.id)) add("BLOCK", "NEW_TERMS_WITHOUT_QUOTE", subject, args);
        else if (!versionContains(c, s)) add("BLOCK", "NEW_TERMS_NOT_IN_VERSION", subject, args);
        else add("CONFIRM", "NEW_TERMS_LINKED", subject, args);
      } else if (s.quoteUpdate === "MANUAL_REVIEW") add("CONFIRM", "STATEMENT_UNCLEAR", subject, args);
      else add("INFO", "STATEMENT_CONFIRMS_ORIGINAL", subject, args);
      if (s.basisChanges.length > 0) add("INFO", "STATEMENT_EARLIER_BASIS", subject, { ...args, reasons: s.basisChanges.join(",") });
    }
  }

  const blocked = findings.some((f) => f.level === "BLOCK");
  if (blocked) amount = null;
  if (amount) money.thisPayment = { currency: amount.currency, minor: amount.minor, display: showMoney({ currency: amount.currency as ExactMoney["currency"], minor: BigInt(amount.minor) }), basis: "FULL_STATED_TOTAL" };

  const snapshot: ApprovalSnapshot = {
    format: SNAPSHOT_FORMAT,
    rules: { approval: APPROVAL_RULES, comparator: COMPARATOR_VERSION, checkRules: CURRENT_CHECK_RULES, replies: REPLY_RULES },
    asOf: input.asOf,
    request: { id: request.id, ref: shortProcurementId(request.id), revision: request.revision, fingerprint: currentFp, quoteSnapshotRevision: version.requestRevision, baseSnapshotRevision: base?.requestRevision ?? null },
    quote: {
      seriesId: version.seriesId,
      seriesRef: shortSeriesId(version.seriesId),
      versionId: version.id,
      versionNumber: version.versionNumber,
      latestVersionNumber: latest,
      contentKind: version.contentKind,
      rawTextSha256: version.rawTextSha256,
      base: base ? { versionId: base.id, versionNumber: base.versionNumber, rawTextSha256: base.rawTextSha256 } : null,
    },
    runs: { run: runView(run), base: baseRun ? runView(baseRun) : null },
    digests: { reviews: reviewsDigest([...input.reviews, ...input.baseReviews]), statements: statementsDigest(input.statements), classifications: classificationsDigest(input.classifications) },
    items,
    terms,
    money,
    statements: [...input.statements]
      .sort((a, b) => (a.answerId < b.answerId ? -1 : 1))
      .map((s) => ({ answerId: s.answerId, number: s.number, field: s.field, kind: s.kind ?? "UNCLASSIFIED", quoteUpdate: s.quoteUpdate, linkedToThisVersion: s.linkedVersionIds.includes(version.id), statement: s.statement })),
    classifications: [...input.classifications].sort((a, b) => (a.subject < b.subject ? -1 : 1)).map((x) => ({ id: x.id, subject: x.subject, decision: x.decision, reason: x.reason, excerpt: x.excerpt })),
    payee: { kind: "FIXED_SANDBOX_TEST_MERCHANT", fingerprint: input.payee.fingerprint },
    environment: "PAYPAL_SANDBOX",
    findings,
  };
  const digest = sha256(`${DIGEST_FORMAT}\n${canonicalJson(snapshot)}`);
  const confirmKeys = findings.filter((f) => f.level === "CONFIRM").map((f) => f.key);
  return { status: blocked ? "BLOCKED" : confirmKeys.length > 0 ? "READY_WITH_CONFIRMATIONS" : "READY", findings, snapshot, digest, amount, confirmKeys };
}

function runView(r: ExtractionRun): RunView {
  return { id: r.id, mode: r.mode, provider: r.provider, model: r.model, status: r.status, checkRules: r.result?.checkRules ?? null };
}

/**
 * A linked "updated quote" must itself contain the condition the statement was about: the version's own (not
 * inherited) value for that field (and item) exists and was reviewed by the user. A link alone proves nothing.
 */
function versionContains(c: Comparison, s: SeriesStatement): boolean {
  if (s.field === "fee") return c.fees.some((f: FeeView) => f.source === "THIS_VERSION" && reviewedValue(f.kind));
  return c.rows.some(
    (r) => r.field === s.field && (s.requestItemId === null || r.requestItemId === s.requestItemId) && r.quote.some((v) => v.source === "THIS_VERSION" && v.used !== null && reviewedValue(v)),
  );
}
