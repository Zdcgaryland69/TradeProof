// Structured supplier quote: what the extraction step produces and the comparator consumes.
// Pure TypeScript (no Node or React imports) so the server and the browser share the same types.
//
// Every extracted value carries `source`, the verbatim document text it was read from, so a person
// can check it. The extraction step (AI, later) only fills this shape; all decisions about
// mismatches are made by the deterministic comparator in quote-compare.ts.

import type { ProcurementRecord } from "./procurement.ts";

export const QUOTE_SCHEMA_VERSION = 1;

/**
 * A value plus the document text it came from.
 * value + source  = stated in the document.
 * null  + source  = the document mentions the field but does not state this value
 *                   (e.g. "Material: stainless steel" → grade not stated).
 * null  + null    = not found in the document.
 */
export interface Sourced<T> {
  value: T | null;
  source: string | null;
}

/** Currencies the comparator accepts. All use 2 decimal places. Amounts never pass through floats. */
export const QUOTE_CURRENCIES = ["USD", "SGD", "CNY"] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];

export interface Money {
  currency: QuoteCurrency;
  /** Integer minor units (cents / fen). */
  minor: number;
}

export const LOGO_METHODS = ["LASER_ENGRAVING", "SCREEN_PRINT", "PAD_PRINT", "PRINT_UNSPECIFIED", "EMBOSSING", "OTHER"] as const;
export type LogoMethod = (typeof LOGO_METHODS)[number];

export interface LogoSpec {
  method: LogoMethod | null;
  colours: number | null;
}

export const INCOTERM_RULES = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
export type IncotermRule = (typeof INCOTERM_RULES)[number];

export interface LeadTime {
  days: number;
  /** AFTER_DEPOSIT = counted from receipt of deposit; UNSPECIFIED = start not stated. */
  basis: "AFTER_DEPOSIT" | "UNSPECIFIED";
  /** "about 30 days" → true. */
  approximate: boolean;
}

export interface PaymentTerms {
  /** Whole percent paid before production, 0 … 100. */
  depositPercent: number;
  balanceTiming: "BEFORE_SHIPMENT" | "AFTER_SHIPMENT" | "OTHER" | null;
}

export interface ExtraCharge {
  description: string;
  /** Set when the charge is for a logo method (e.g. laser engraving surcharge). */
  logoMethod: LogoMethod | null;
  perUnit: Money | null;
}

export interface QuoteItem {
  name: Sourced<string>;
  /** Stainless steel grade, e.g. "304", "201". */
  materialGrade: Sourced<string>;
  logo: Sourced<LogoSpec>;
  quantity: Sourced<number>;
  unit: Sourced<string>;
  unitPrice: Sourced<Money>;
}

export interface ExtractedQuote {
  _notice?: string;
  schemaVersion: typeof QUOTE_SCHEMA_VERSION;
  /** Which document this was read from (file name or upload id). */
  documentId: string;
  /** BCP 47 language of the document, e.g. "zh", "en". */
  language: string;
  quoteNumber: Sourced<string>;
  /** YYYY-MM-DD. */
  quoteDate: Sourced<string>;
  items: QuoteItem[];
  total: Sourced<Money>;
  incoterm: Sourced<{ rule: IncotermRule; place: string | null }>;
  leadTime: Sourced<LeadTime>;
  paymentTerms: Sourced<PaymentTerms>;
  extraCharges: Sourced<ExtraCharge>[];
}

// ---------- source checks ----------

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Paths ("items[0].quantity", "extraCharges[0]" …) of every Sourced field, with its source text. */
export function sourcedFields(quote: ExtractedQuote): { path: string; source: string | null }[] {
  const out: { path: string; source: string | null }[] = [];
  const add = (path: string, s: Sourced<unknown>) => out.push({ path, source: s.source });
  add("quoteNumber", quote.quoteNumber);
  add("quoteDate", quote.quoteDate);
  quote.items.forEach((item, i) => {
    add(`items[${i}].name`, item.name);
    add(`items[${i}].materialGrade`, item.materialGrade);
    add(`items[${i}].logo`, item.logo);
    add(`items[${i}].quantity`, item.quantity);
    add(`items[${i}].unit`, item.unit);
    add(`items[${i}].unitPrice`, item.unitPrice);
  });
  add("total", quote.total);
  add("incoterm", quote.incoterm);
  add("leadTime", quote.leadTime);
  add("paymentTerms", quote.paymentTerms);
  quote.extraCharges.forEach((c, i) => add(`extraCharges[${i}]`, c));
  return out;
}

/**
 * Fields whose source text does not occur in the document (whitespace-insensitive).
 * A value stated without any source is also reported: nothing can be shown to the person.
 * Used to reject extraction output that quotes text the document does not contain.
 */
export function unverifiedSources(documentText: string, quote: ExtractedQuote): string[] {
  const doc = collapse(documentText);
  const bad: string[] = [];
  for (const { path, source } of sourcedFields(quote)) {
    if (source === null) continue;
    if (collapse(source) === "" || !doc.includes(collapse(source))) bad.push(path);
  }
  const statedWithoutSource = (path: string, s: Sourced<unknown>) => {
    if (s.value !== null && s.source === null) bad.push(path);
  };
  quote.items.forEach((item, i) => {
    for (const key of ["name", "materialGrade", "logo", "quantity", "unit", "unitPrice"] as const) {
      statedWithoutSource(`items[${i}].${key}`, item[key]);
    }
  });
  for (const key of ["quoteNumber", "quoteDate", "total", "incoterm", "leadTime", "paymentTerms"] as const) {
    statedWithoutSource(key, quote[key]);
  }
  quote.extraCharges.forEach((c, i) => statedWithoutSource(`extraCharges[${i}]`, c));
  return [...new Set(bad)];
}

// ---------- display ----------

export function formatMoney(m: Money): string {
  return `${m.currency} ${Math.floor(m.minor / 100)}.${String(m.minor % 100).padStart(2, "0")}`;
}

const LOGO_LABEL: Record<LogoMethod, string> = {
  LASER_ENGRAVING: "laser engraving",
  SCREEN_PRINT: "screen print",
  PAD_PRINT: "pad print",
  PRINT_UNSPECIFIED: "printed (method not stated)",
  EMBOSSING: "embossing",
  OTHER: "other method",
};

export function formatLogo(l: LogoSpec): string {
  const method = l.method ? LOGO_LABEL[l.method] : "method not stated";
  const colours = l.colours === null ? "colours not stated" : `${l.colours} colour${l.colours === 1 ? "" : "s"}`;
  return `${method}, ${colours}`;
}

export function formatLeadTime(t: LeadTime): string {
  return `${t.approximate ? "about " : ""}${t.days} days${t.basis === "AFTER_DEPOSIT" ? " after deposit" : " (start not stated)"}`;
}

export function formatPaymentTerms(p: PaymentTerms): string {
  const timing = { BEFORE_SHIPMENT: "before shipment", AFTER_SHIPMENT: "after shipment", OTHER: "other timing" } as const;
  return `${p.depositPercent}% deposit, balance ${p.balanceTiming ? timing[p.balanceTiming] : "timing not stated"}`;
}

// ---------- the request side ----------
// Request fields are free text typed by the buyer. These parsers only recognise clear wording;
// anything else becomes null and the comparator reports "cannot compare" instead of guessing.

export interface ComparableRequestItem {
  position: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  materialText: string | null;
  materialGrade: string | null;
  logoText: string | null;
  logo: LogoSpec | null;
}

export interface ComparableRequest {
  id: string;
  items: ComparableRequestItem[];
  /** Total budget cap. */
  budget: Money | null;
  requiredShipDate: string | null;
  incotermText: string | null;
  incotermRule: IncotermRule | null;
  paymentTermsText: string | null;
  paymentTerms: PaymentTerms | null;
}

const GRADE = /(?:^|[^\d])(201|202|304L?|316L?|410|430)(?![\d])/i;

export function parseMaterialGrade(text: string | null): string | null {
  if (!text) return null;
  const m = GRADE.exec(text);
  return m ? m[1].toUpperCase() : null;
}

const LOGO_WORDS: [RegExp, LogoMethod][] = [
  [/laser|激光/i, "LASER_ENGRAVING"],
  [/silk[\s-]?screen|screen[\s-]?print|丝印|丝网/i, "SCREEN_PRINT"],
  [/pad[\s-]?print|移印/i, "PAD_PRINT"],
  [/emboss|压印|凸印/i, "EMBOSSING"],
  [/print|印刷/i, "PRINT_UNSPECIFIED"],
];

export function parseLogo(text: string | null): LogoSpec | null {
  if (!text) return null;
  const method = LOGO_WORDS.find(([re]) => re.test(text))?.[1] ?? null;
  const c = /(\d+)\s*(?:colou?rs?|色)/i.exec(text);
  const colours = c ? Number(c[1]) : /single[\s-]colou?r|单色/i.test(text) ? 1 : null;
  return method === null && colours === null ? null : { method, colours };
}

export function parsePaymentTerms(text: string | null): PaymentTerms | null {
  if (!text) return null;
  const d = /(\d{1,3})\s*%\s*(?:deposit|down|advance|定金|订金|预付)/i.exec(text) ?? /(?:deposit|定金|订金|预付)\D{0,10}?(\d{1,3})\s*%/i.exec(text);
  if (!d) return null;
  const depositPercent = Number(d[1]);
  if (depositPercent > 100) return null;
  const balanceTiming = /before\s+(?:shipment|shipping|delivery)|发货前|出货前|装运前/i.test(text)
    ? "BEFORE_SHIPMENT"
    : /after\s+(?:shipment|shipping|delivery)|against\s+(?:b\/l|bl|bill of lading)|发货后|出货后/i.test(text)
      ? "AFTER_SHIPMENT"
      : null;
  return { depositPercent, balanceTiming };
}

export function parseIncotermRule(text: string | null): IncotermRule | null {
  if (!text) return null;
  const m = new RegExp(`\\b(${INCOTERM_RULES.join("|")})\\b`).exec(text.toUpperCase());
  return m ? (m[1] as IncotermRule) : null;
}

/** "收到定金后 35 天" / "about 30 days" → LeadTime; null when the wording is not clear. */
export function parseLeadTimeText(text: string): LeadTime | null {
  const m = /(\d{1,3})\s*(?:天|日|days?|calendar days)/i.exec(text);
  if (!m) return null;
  return {
    days: Number(m[1]),
    basis: /定金后|订金后|after\s+(?:receipt\s+of\s+)?(?:the\s+)?deposit/i.test(text) ? "AFTER_DEPOSIT" : "UNSPECIFIED",
    approximate: /about|approx|around|约|大约|左右/i.test(text),
  };
}

/** Stored procurement request → comparable form. */
export function comparableFromRecord(record: ProcurementRecord): ComparableRequest {
  const incotermText =
    [record.shipFrom, record.additionalRequirements].find((t) => t !== null && parseIncotermRule(t) !== null) ?? null;
  const budget =
    record.budgetCurrency !== null && record.budgetMaxMinor !== null
      ? { currency: record.budgetCurrency, minor: record.budgetMaxMinor }
      : null;
  return {
    id: record.id,
    items: record.items.map((item) => ({
      position: item.position,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      materialText: item.material,
      materialGrade: parseMaterialGrade(item.material),
      logoText: item.customization,
      logo: parseLogo(item.customization),
    })),
    budget,
    requiredShipDate: record.requiredShipDate,
    incotermText,
    incotermRule: parseIncotermRule(incotermText),
    paymentTermsText: record.paymentTerms,
    paymentTerms: parsePaymentTerms(record.paymentTerms),
  };
}
