// Server-side checks of a model's extraction output. Pure functions (no I/O, no model calls).
//
// The model only proposes values with verbatim excerpts. This module decides, with plain code:
//   - whether the output has exactly the expected shape (anything else → the whole output is refused);
//   - whether each excerpt occurs in THIS version's stored text (located here, never trusted from the model);
//   - whether the value is inside its excerpt, by field type (numbers.ts, rules VALUE_CHECK_RULES):
//     quantities and amounts as parsed numbers with digit boundaries and the right role (a quantity is
//     never taken from a product code, a measure, an amount or a percentage), text with digit boundaries;
//     ambiguous number formats, currencies or units → AMBIGUOUS_VALUE (left to the user);
//   - amounts → integer minor units, quantities → integers (no floats, no currency conversion);
//   - item match candidates → only lines of the request snapshot this version was saved with;
//   - arithmetic and a display-only cost overview from SUPPORTED facts only.
// A fact that fails a check keeps the model's words for review but gets value = null ("unknown").
// A fact that passes is SUPPORTED: "the source excerpt was found", never "semantically verified".

import {
  EXTRACTION_SCHEMA_VERSION,
  FACT_CHECKS,
  FEE_KINDS,
  FEE_PARTIES,
  FEE_STATED_AS,
  INCLUDED_VALUES,
  PROBLEM_CHECKS,
  type ArithmeticCheck,
  type CostSummary,
  type Evidence,
  type ExtractedItem,
  type ExtractionResult,
  type Fact,
  type FactCheck,
  type FeeLine,
  type ItemMatch,
  type SourcedMoney,
  type ValueCheck,
} from "../../lib/extraction.ts";
import { VALUE_CHECK_RULES, checkAmountValue, checkQuantityValue, checkTextValue, currenciesIn, nfkc } from "./numbers.ts";
import {
  QUOTE_CURRENCIES,
  QUOTE_SCHEMA_VERSION,
  parseIncotermRule,
  parseLeadTimeText,
  parseLogo,
  parseMaterialGrade,
  parsePaymentTerms,
  type ExtractedQuote,
  type QuoteCurrency,
  type Sourced,
} from "../../lib/quote.ts";

// ---------- the model's output shape (strict) ----------

export interface ModelText {
  value: string | null;
  quote: string | null;
}
export interface ModelMoney {
  amount: string | null;
  currency: string | null;
  quote: string | null;
}
export interface ModelItem {
  name: ModelText;
  quantity: ModelText;
  unit: ModelText;
  material: ModelText;
  specification: ModelText;
  logo: ModelText;
  unitPrice: ModelMoney;
  requestItemCandidates: string[];
}
export interface ModelFee {
  kind: ModelText;
  description: ModelText;
  amount: ModelMoney;
  amountBasis: ModelText;
  payer: ModelText;
  payee: ModelText;
  includedInQuote: ModelText;
  statedAs: ModelText;
}
export interface ModelOutput {
  supplierQuoteNumbers: ModelText[];
  quoteDate: ModelText;
  currency: ModelText;
  items: ModelItem[];
  total: ModelMoney;
  incoterm: ModelText;
  leadTime: ModelText;
  paymentTerms: ModelText;
  fees: ModelFee[];
}

const TOP_KEYS = ["supplierQuoteNumbers", "quoteDate", "currency", "items", "total", "incoterm", "leadTime", "paymentTerms", "fees"];
const ITEM_KEYS = ["name", "quantity", "unit", "material", "specification", "logo", "unitPrice", "requestItemCandidates"];
const FEE_KEYS = ["kind", "description", "amount", "amountBasis", "payer", "payee", "includedInQuote", "statedAs"];
const MAX = { items: 50, fees: 30, quoteNumbers: 5, candidates: 10, string: 2000 };

export type ParsedOutput = { ok: true; value: ModelOutput } | { ok: false; problems: string[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses the model's reply. Accepts a bare JSON object, or one wrapped in a single ```json fence.
 * Refuses anything else: extra or missing keys, wrong types, over-long strings, tool requests.
 */
export function parseModelOutput(text: string): ParsedOutput {
  const problems: string[] = [];
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  let data: unknown;
  try {
    data = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return { ok: false, problems: ["The output is not valid JSON."] };
  }
  const keys = (obj: Record<string, unknown>, expected: string[], at: string) => {
    for (const k of Object.keys(obj)) if (!expected.includes(k)) problems.push(`${at}: unexpected key "${k}"`);
    for (const k of expected) if (!(k in obj)) problems.push(`${at}: missing key "${k}"`);
  };
  const str = (v: unknown, at: string): string | null => {
    if (v === null) return null;
    if (typeof v !== "string") {
      problems.push(`${at}: must be a string or null`);
      return null;
    }
    if (v.length > MAX.string) problems.push(`${at}: longer than ${MAX.string} characters`);
    return v;
  };
  const textField = (v: unknown, at: string): ModelText => {
    if (v === null) return { value: null, quote: null };
    if (!isObject(v)) {
      problems.push(`${at}: must be an object or null`);
      return { value: null, quote: null };
    }
    keys(v, ["value", "quote"], at);
    return { value: str(v.value, `${at}.value`), quote: str(v.quote, `${at}.quote`) };
  };
  const moneyField = (v: unknown, at: string): ModelMoney => {
    if (v === null) return { amount: null, currency: null, quote: null };
    if (!isObject(v)) {
      problems.push(`${at}: must be an object or null`);
      return { amount: null, currency: null, quote: null };
    }
    keys(v, ["amount", "currency", "quote"], at);
    return { amount: str(v.amount, `${at}.amount`), currency: str(v.currency, `${at}.currency`), quote: str(v.quote, `${at}.quote`) };
  };
  const list = (v: unknown, at: string, max: number): unknown[] => {
    if (!Array.isArray(v)) {
      problems.push(`${at}: must be an array`);
      return [];
    }
    if (v.length > max) problems.push(`${at}: more than ${max} entries`);
    return v.slice(0, max);
  };

  if (!isObject(data)) return { ok: false, problems: ["The output must be one JSON object."] };
  keys(data, TOP_KEYS, "output");
  const out: ModelOutput = {
    supplierQuoteNumbers: list(data.supplierQuoteNumbers, "supplierQuoteNumbers", MAX.quoteNumbers).map((v, i) => textField(v, `supplierQuoteNumbers[${i}]`)),
    quoteDate: textField(data.quoteDate ?? null, "quoteDate"),
    currency: textField(data.currency ?? null, "currency"),
    items: list(data.items, "items", MAX.items).map((raw, i) => {
      const at = `items[${i}]`;
      if (!isObject(raw)) {
        problems.push(`${at}: must be an object`);
        raw = {};
      }
      const r = raw as Record<string, unknown>;
      keys(r, ITEM_KEYS, at);
      const candidates = list(r.requestItemCandidates ?? [], `${at}.requestItemCandidates`, MAX.candidates).map((c, j) => str(c, `${at}.requestItemCandidates[${j}]`) ?? "");
      return {
        name: textField(r.name ?? null, `${at}.name`),
        quantity: textField(r.quantity ?? null, `${at}.quantity`),
        unit: textField(r.unit ?? null, `${at}.unit`),
        material: textField(r.material ?? null, `${at}.material`),
        specification: textField(r.specification ?? null, `${at}.specification`),
        logo: textField(r.logo ?? null, `${at}.logo`),
        unitPrice: moneyField(r.unitPrice ?? null, `${at}.unitPrice`),
        requestItemCandidates: candidates,
      };
    }),
    total: moneyField(data.total ?? null, "total"),
    incoterm: textField(data.incoterm ?? null, "incoterm"),
    leadTime: textField(data.leadTime ?? null, "leadTime"),
    paymentTerms: textField(data.paymentTerms ?? null, "paymentTerms"),
    fees: list(data.fees, "fees", MAX.fees).map((raw, i) => {
      const at = `fees[${i}]`;
      if (!isObject(raw)) {
        problems.push(`${at}: must be an object`);
        raw = {};
      }
      const r = raw as Record<string, unknown>;
      keys(r, FEE_KEYS, at);
      return {
        kind: textField(r.kind ?? null, `${at}.kind`),
        description: textField(r.description ?? null, `${at}.description`),
        amount: moneyField(r.amount ?? null, `${at}.amount`),
        amountBasis: textField(r.amountBasis ?? null, `${at}.amountBasis`),
        payer: textField(r.payer ?? null, `${at}.payer`),
        payee: textField(r.payee ?? null, `${at}.payee`),
        includedInQuote: textField(r.includedInQuote ?? null, `${at}.includedInQuote`),
        statedAs: textField(r.statedAs ?? null, `${at}.statedAs`),
      };
    }),
  };
  return problems.length > 0 ? { ok: false, problems: problems.slice(0, 50) } : { ok: true, value: out };
}

// ---------- locating excerpts ----------

/** Whitespace runs collapsed to one space, with a map back to offsets in the original text. */
function collapseWithMap(text: string): { flat: string; map: number[] } {
  let flat = "";
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace && flat.length > 0) {
        flat += " ";
        map.push(i);
      }
      inSpace = true;
    } else {
      flat += ch;
      map.push(i);
      inSpace = false;
    }
  }
  return { flat, map };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Finds `excerpt` in `text`: exact first, then ignoring differences in whitespace. Returns the exact
 * slice of the stored text, its offsets and line, and how many places match. null when absent.
 */
export function locate(text: string, excerpt: string): Evidence | null {
  const needle = excerpt.trim();
  if (needle === "") return null;
  const count = (hay: string, n: string) => {
    let c = 0;
    for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + 1)) c++;
    return c;
  };
  const exact = text.indexOf(needle);
  if (exact !== -1) {
    return { excerpt: needle, start: exact, end: exact + needle.length, line: text.slice(0, exact).split("\n").length, occurrences: count(text, needle) };
  }
  const { flat, map } = collapseWithMap(text);
  const n = squash(needle);
  const at = flat.indexOf(n);
  if (at === -1) return null;
  const start = map[at];
  const end = map[at + n.length - 1] + 1;
  return { excerpt: text.slice(start, end), start, end, line: text.slice(0, start).split("\n").length, occurrences: count(flat, n) };
}

const INSTRUCTION_LIKE =
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)|disregard\s+(all\s+|the\s+)?(previous|prior|above)?\s*instructions|system\s+prompt|you\s+are\s+(now\s+)?(an?|the)\s+(ai|assistant|model)|new\s+instructions?:|忽略(以上|之前|前面|上述)|无视.{0,10}(指令|指示)|系统提示|新的指令/i;

/** Quote text is data. An excerpt that addresses the assistant is never used as evidence. */
export function looksLikeInstruction(excerpt: string): boolean {
  return INSTRUCTION_LIKE.test(excerpt);
}

/** The whole line(s) of `text` an evidence span sits on — a partial quote of an injected line is still on that line. */
function linesAround(text: string, ev: Evidence): string {
  const from = text.lastIndexOf("\n", ev.start - 1) + 1;
  const to = text.indexOf("\n", ev.end);
  return text.slice(from, to === -1 ? text.length : to);
}

// ---------- deterministic value parsing ----------

/** "11,760.00" / "1760" / "24.5" (full-width digits allowed) → minor units (2 decimals). Ambiguous forms ("1.800,00", "1,80") → null. */
export function parseAmountText(text: string): number | null {
  const t = nfkc(text).trim();
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const minor = whole * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** "480" / "1,000" → whole number 1 … 100,000,000; anything else → null. */
export function parseQuantityText(text: string): number | null {
  const t = nfkc(text).trim();
  if (!/^(\d{1,3}(?:,\d{3})+|\d+)$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isSafeInteger(n) && n > 0 && n <= 100_000_000 ? n : null;
}

export { currenciesIn };

// ---------- building facts ----------

interface Ctx {
  text: string;
  contextText: string | null;
}

function fact<T>(
  kind: Fact<T>["kind"],
  modelValue: string | null,
  modelExcerpt: string | null,
  check: FactCheck,
  evidence: Evidence | null,
  value: NoInfer<T> | null,
  note: string | null = null,
  valueCheck: ValueCheck | null = null,
): Fact<T> {
  const f: Fact<T> = { value: check === "SUPPORTED" ? value : null, modelValue, modelExcerpt, kind, check, evidence, note };
  if (valueCheck) f.valueCheck = valueCheck;
  return f;
}

/** MATCH → SUPPORTED, AMBIGUOUS → AMBIGUOUS_VALUE, NO_MATCH → VALUE_NOT_IN_EXCERPT. */
const checkFor = (vc: ValueCheck): FactCheck => (vc.outcome === "MATCH" ? "SUPPORTED" : vc.outcome === "AMBIGUOUS" ? "AMBIGUOUS_VALUE" : "VALUE_NOT_IN_EXCERPT");

/** Common steps: not stated / no excerpt / excerpt located in this text (or only in the context) / instruction-like. */
function evidenceFor(ctx: Ctx, modelValue: string | null, quote: string | null): { check: FactCheck; evidence: Evidence | null } | null {
  const q = quote !== null && quote.trim() !== "" ? quote : null;
  if (modelValue === null || modelValue.trim() === "") {
    return { check: "NOT_STATED", evidence: q ? locate(ctx.text, q) : null };
  }
  if (q === null) return { check: "NO_EXCERPT", evidence: null };
  const evidence = locate(ctx.text, q);
  if (!evidence) {
    const inContext = ctx.contextText !== null && locate(ctx.contextText, q) !== null;
    return { check: inContext ? "ONLY_IN_CONTEXT" : "NOT_IN_TEXT", evidence: null };
  }
  if (looksLikeInstruction(linesAround(ctx.text, evidence))) return { check: "SUSPICIOUS_EXCERPT", evidence };
  return null; // located and plausible: the caller checks the value against it
}

export function verbatimFact(ctx: Ctx, m: ModelText): Fact<string> {
  const pre = evidenceFor(ctx, m.value, m.quote);
  if (pre) return fact("VERBATIM", m.value, m.quote, pre.check, pre.evidence, null);
  const ev = locate(ctx.text, m.quote!)!;
  const vc = checkTextValue(ev.excerpt, m.value!);
  return fact("VERBATIM", m.value, m.quote, checkFor(vc), ev, m.value!.trim(), vc.note, vc);
}

export function enumFact<T extends string>(ctx: Ctx, m: ModelText, allowed: readonly T[]): Fact<T> {
  const pre = evidenceFor(ctx, m.value, m.quote);
  if (pre) return fact("INTERPRETED", m.value, m.quote, pre.check, pre.evidence, null);
  const ev = locate(ctx.text, m.quote!)!;
  const v = m.value!.trim().toUpperCase() as T;
  return allowed.includes(v)
    ? fact("INTERPRETED", m.value, m.quote, "SUPPORTED", ev, v, "The model's reading of the excerpt — check it.")
    : fact("INTERPRETED", m.value, m.quote, "INVALID_VALUE", ev, null, `Not one of: ${allowed.join(", ")}.`);
}

export function quantityFact(ctx: Ctx, m: ModelText): Fact<number> {
  const pre = evidenceFor(ctx, m.value, m.quote);
  if (pre) return fact("VERBATIM", m.value, m.quote, pre.check, pre.evidence, null);
  const ev = locate(ctx.text, m.quote!)!;
  const n = parseQuantityText(m.value!);
  if (n === null) return fact("VERBATIM", m.value, m.quote, "INVALID_VALUE", ev, null, "Not a whole number as written (e.g. 500 or 1,000).");
  const vc = checkQuantityValue(ev.excerpt, m.value!, n);
  return fact("VERBATIM", m.value, m.quote, checkFor(vc), ev, n, vc.note, vc);
}

export function currencyFact(ctx: Ctx, m: ModelText): Fact<QuoteCurrency> {
  const pre = evidenceFor(ctx, m.value, m.quote);
  if (pre) return fact("VERBATIM", m.value, m.quote, pre.check, pre.evidence, null);
  const ev = locate(ctx.text, m.quote!)!;
  const code = m.value!.trim().toUpperCase();
  if (!(QUOTE_CURRENCIES as readonly string[]).includes(code)) {
    return fact("VERBATIM", m.value, m.quote, "INVALID_VALUE", ev, null, `Only ${QUOTE_CURRENCIES.join(", ")} are supported; other currencies stay as text.`);
  }
  return currenciesIn(ev.excerpt).includes(code as QuoteCurrency)
    ? fact("VERBATIM", m.value, m.quote, "SUPPORTED", ev, code as QuoteCurrency)
    : fact("VERBATIM", m.value, m.quote, "VALUE_NOT_IN_EXCERPT", ev, null, "The excerpt does not name this currency (a bare $ or ¥ is ambiguous).");
}

export function moneyFact(ctx: Ctx, m: ModelMoney): Fact<SourcedMoney> {
  const shown = m.amount === null ? null : `${m.currency ?? "?"} ${m.amount}`;
  const pre = evidenceFor(ctx, m.amount, m.quote);
  if (pre) return fact("VERBATIM", shown, m.quote, pre.check, pre.evidence, null);
  const ev = locate(ctx.text, m.quote!)!;
  const minor = parseAmountText(m.amount!);
  if (minor === null) return fact("VERBATIM", shown, m.quote, "INVALID_VALUE", ev, null, "Amount format not recognised (expected e.g. 11,760.00 or 24.50).");
  const code = (m.currency ?? "").trim().toUpperCase();
  if (!(QUOTE_CURRENCIES as readonly string[]).includes(code)) {
    return fact("VERBATIM", shown, m.quote, "INVALID_VALUE", ev, null, `Currency must be one of ${QUOTE_CURRENCIES.join(", ")}.`);
  }
  const vc = checkAmountValue(ev.excerpt, m.amount!, minor, code as QuoteCurrency);
  return fact("VERBATIM", shown, m.quote, checkFor(vc), ev, { amountText: m.amount!.trim(), currency: code as QuoteCurrency, minor }, vc.note, vc);
}

// ---------- items, fees, totals ----------

export function checkItemMatch(candidates: string[], snapshotItemIds: ReadonlySet<string>): ItemMatch {
  const unique = [...new Set(candidates.filter((c) => c !== ""))];
  const candidateIds = unique.filter((id) => snapshotItemIds.has(id));
  const rejectedIds = unique.filter((id) => !snapshotItemIds.has(id));
  const status = candidateIds.length === 1 ? "PROPOSED" : candidateIds.length > 1 ? "AMBIGUOUS" : "UNMATCHED";
  return { status, candidateIds, rejectedIds };
}

function feeLine(ctx: Ctx, m: ModelFee): FeeLine {
  const amount = moneyFact(ctx, m.amount);
  const statedAs = enumFact(ctx, m.statedAs, FEE_STATED_AS);
  // "Firm" needs an amount the text supports; otherwise it is at most "to be confirmed".
  if (statedAs.value === "FIRM" && amount.check !== "SUPPORTED") {
    statedAs.value = "TO_BE_CONFIRMED";
    statedAs.note = "The model read this as firm, but no amount is supported by the text — treated as to be confirmed.";
  }
  return {
    kind: enumFact(ctx, m.kind, FEE_KINDS),
    description: verbatimFact(ctx, m.description),
    amount,
    amountBasis: enumFact(ctx, m.amountBasis, ["PER_UNIT", "LUMP_SUM"] as const),
    payer: enumFact(ctx, m.payer, FEE_PARTIES),
    payee: enumFact(ctx, m.payee, FEE_PARTIES),
    includedInQuote: enumFact(ctx, m.includedInQuote, INCLUDED_VALUES),
    statedAs,
  };
}

/** Σ quantity × unit price against the stated total, in integer minor units (BigInt), same currency only. */
export function arithmeticChecks(items: ExtractedItem[], total: Fact<SourcedMoney>): ArithmeticCheck[] {
  if (total.value === null) return [{ code: "CANNOT_CHECK_TOTAL", message: "No total supported by the text." }];
  if (items.length === 0 || items.some((i) => i.quantity.value === null || i.unitPrice.value === null)) {
    return [{ code: "CANNOT_CHECK_TOTAL", message: "Some items have no supported quantity or unit price." }];
  }
  if (items.some((i) => i.unitPrice.value!.currency !== total.value!.currency)) {
    return [{ code: "CANNOT_CHECK_TOTAL", message: "Unit prices and total are in different currencies; nothing is converted." }];
  }
  const sum = items.reduce((acc, i) => acc + BigInt(i.quantity.value!) * BigInt(i.unitPrice.value!.minor), BigInt(0));
  const hundred = BigInt(100);
  const fmt = (v: bigint) => `${v / hundred}.${String(v % hundred).padStart(2, "0")}`;
  return sum === BigInt(total.value.minor)
    ? [{ code: "TOTAL_MATCHES_ITEMS", message: `Quantity × unit price = ${total.value.currency} ${fmt(sum)}, equal to the stated total.` }]
    : [{ code: "TOTAL_ARITHMETIC_MISMATCH", message: `Quantity × unit price = ${total.value.currency} ${fmt(sum)}, but the stated total is ${total.value.currency} ${total.value.amountText}.` }];
}

/**
 * Display-only overview per currency. Counts only facts the text supports: the quoted total, plus fees
 * stated as NOT included with a lump-sum amount. Everything else (unknown amount, unknown inclusion,
 * per-unit or optional charges) is counted as unknown, never as 0. Never sums across currencies.
 */
export function costSummary(total: Fact<SourcedMoney>, fees: FeeLine[]): CostSummary {
  const lines = new Map<QuoteCurrency, CostSummary["lines"][number]>();
  const line = (c: QuoteCurrency) => {
    if (!lines.has(c)) lines.set(c, { currency: c, quotedTotalMinor: null, extraKnownMinor: 0, extraKnownCount: 0 });
    return lines.get(c)!;
  };
  if (total.value) line(total.value.currency).quotedTotalMinor = total.value.minor;
  let unknownFeeCount = 0;
  for (const f of fees) {
    if (f.statedAs.value === "NOT_APPLICABLE" || f.includedInQuote.value === "INCLUDED") continue;
    if (f.includedInQuote.value === "NOT_INCLUDED" && f.amount.value && f.amountBasis.value === "LUMP_SUM" && f.statedAs.value === "FIRM") {
      const l = line(f.amount.value.currency);
      l.extraKnownMinor += f.amount.value.minor;
      l.extraKnownCount += 1;
    } else {
      unknownFeeCount += 1;
    }
  }
  return { lines: [...lines.values()], unknownFeeCount };
}

function countChecks(result: Omit<ExtractionResult, "counts">): Record<FactCheck, number> {
  const counts = Object.fromEntries(FACT_CHECKS.map((c) => [c, 0])) as Record<FactCheck, number>;
  const visit = (f: Fact<unknown>) => counts[f.check]++;
  result.supplierQuoteNumbers.forEach(visit);
  [result.quoteDate, result.currency, result.total, result.incoterm, result.leadTime, result.paymentTerms].forEach(visit);
  for (const i of result.items) [i.name, i.quantity, i.unit, i.material, i.specification, i.logo, i.unitPrice].forEach(visit);
  for (const f of result.fees) [f.kind, f.description, f.amount, f.amountBasis, f.payer, f.payee, f.includedInQuote, f.statedAs].forEach(visit);
  return counts;
}

export interface CheckInput {
  /** The stored raw text of the version being extracted (read by the server). */
  text: string;
  /** SUPPLEMENT only: the stored text of the version it adds to — context, never evidence. */
  contextText: string | null;
  contentKind: "FULL_QUOTE" | "SUPPLEMENT";
  /** Item line ids of the request snapshot this version was saved with. */
  snapshotItemIds: ReadonlySet<string>;
}

export function checkExtraction(output: ModelOutput, input: CheckInput): ExtractionResult {
  const ctx: Ctx = { text: input.text, contextText: input.contextText };
  const items: ExtractedItem[] = output.items.map((m) => ({
    name: verbatimFact(ctx, m.name),
    quantity: quantityFact(ctx, m.quantity),
    unit: verbatimFact(ctx, m.unit),
    material: verbatimFact(ctx, m.material),
    specification: verbatimFact(ctx, m.specification),
    logo: verbatimFact(ctx, m.logo),
    unitPrice: moneyFact(ctx, m.unitPrice),
    match: checkItemMatch(m.requestItemCandidates, input.snapshotItemIds),
  }));
  const total = moneyFact(ctx, output.total);
  const fees = output.fees.map((f) => feeLine(ctx, f));
  const partial: Omit<ExtractionResult, "counts"> = {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    checkRules: VALUE_CHECK_RULES,
    contentKind: input.contentKind,
    supplierQuoteNumbers: output.supplierQuoteNumbers.map((q) => verbatimFact(ctx, q)),
    quoteDate: verbatimFact(ctx, output.quoteDate),
    currency: currencyFact(ctx, output.currency),
    items,
    total,
    incoterm: verbatimFact(ctx, output.incoterm),
    leadTime: verbatimFact(ctx, output.leadTime),
    paymentTerms: verbatimFact(ctx, output.paymentTerms),
    fees,
    arithmetic: arithmeticChecks(items, total),
    costSummary: costSummary(total, fees),
  };
  return { ...partial, counts: countChecks(partial) };
}

/** INCOMPLETE when any fact failed a check; SUCCEEDED otherwise (NOT_STATED is a normal answer). */
export function resultStatus(result: ExtractionResult): "SUCCEEDED" | "INCOMPLETE" {
  return PROBLEM_CHECKS.some((c) => result.counts[c] > 0) ? "INCOMPLETE" : "SUCCEEDED";
}

// ---------- adapter to the deterministic comparator (9300eda) ----------

// parseLeadTimeText moved to src/lib/quote.ts (26 Oct, shared with the comparator); re-exported here.
export { parseLeadTimeText };

const sourced = <T>(value: T | null, f: Fact<unknown>): Sourced<T> => ({ value: f.check === "SUPPORTED" ? value : null, source: f.check === "SUPPORTED" ? f.evidence!.excerpt : null });

/**
 * SUPPORTED facts only → the comparator's ExtractedQuote. A SUPPLEMENT returns null: it is not a full
 * quote and must not be compared as one (terms it does not mention are not "missing"). A result checked
 * with older value rules (before 25 Oct: substring test, so "500" could be "found" in "1500") also
 * returns null: it is never fed to the comparator as if it had passed the current checks.
 */
export function toComparatorQuote(result: ExtractionResult, documentId: string, language: string): ExtractedQuote | null {
  if (result.contentKind !== "FULL_QUOTE") return null;
  if (result.checkRules !== VALUE_CHECK_RULES) return null;
  const incotermRule = result.incoterm.value ? parseIncotermRule(result.incoterm.value) : null;
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    documentId,
    language,
    quoteNumber: sourced(result.supplierQuoteNumbers.find((q) => q.value !== null)?.value ?? null, result.supplierQuoteNumbers.find((q) => q.value !== null) ?? result.quoteDate),
    quoteDate: sourced(/^\d{4}-\d{2}-\d{2}$/.test(result.quoteDate.value ?? "") ? result.quoteDate.value : null, result.quoteDate),
    items: result.items.map((i) => ({
      name: sourced(i.name.value, i.name),
      materialGrade: sourced(parseMaterialGrade(i.material.value), i.material),
      logo: sourced(parseLogo(i.logo.value), i.logo),
      quantity: sourced(i.quantity.value, i.quantity),
      unit: sourced(i.unit.value, i.unit),
      unitPrice: sourced(i.unitPrice.value ? { currency: i.unitPrice.value.currency, minor: i.unitPrice.value.minor } : null, i.unitPrice),
    })),
    total: sourced(result.total.value ? { currency: result.total.value.currency, minor: result.total.value.minor } : null, result.total),
    incoterm: sourced(incotermRule ? { rule: incotermRule, place: result.incoterm.value!.replace(/^\s*[A-Z]{3}\s*/, "").trim() || null } : null, result.incoterm),
    leadTime: sourced(result.leadTime.value ? parseLeadTimeText(result.leadTime.value) : null, result.leadTime),
    paymentTerms: sourced(result.paymentTerms.value ? parsePaymentTerms(result.paymentTerms.value) : null, result.paymentTerms),
    extraCharges: result.fees
      .filter((f) => f.description.check === "SUPPORTED")
      .map((f) => ({
        value: {
          description: f.description.value!,
          logoMethod: parseLogo(f.description.value)?.method ?? null,
          perUnit: f.amountBasis.value === "PER_UNIT" && f.amount.value ? { currency: f.amount.value.currency, minor: f.amount.value.minor } : null,
        },
        source: f.description.evidence!.excerpt,
      })),
  };
}
