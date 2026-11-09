// Number-aware value checks for extraction evidence. Pure functions (no I/O, no model calls).
//
// Replaces the 24 Oct substring test, under which quantity "500" was found inside "1500 pcs" and
// USD 3.20 inside "USD 13.20". An excerpt is scanned into number tokens with digit boundaries; each
// token keeps its exact original span (full-width digits stay as written) and gets:
//   - its possible readings (an ambiguous format such as "1.500", "1,80" or "1.800,00" has several or
//     none that we accept, and is never silently picked);
//   - a role from its neighbours: MONEY (a currency marker next to it), COUNT (pcs, 个, sets …),
//     MEASURE (ml, kg, days, 天 …), PERCENT, CODE (part of a model / item / quote number such as
//     "BT-500", "No. 500", "型号 500", "500A") or BARE (none of these).
// Each field type accepts only fitting roles: a quantity never matches a code, a measure, an amount or
// a percentage; an amount never matches a count or a code; and the claimed currency must be the one
// next to the number, or the only one the excerpt names.
//
// What this proves: the stated value occurs as a number of the right kind inside the cited excerpt,
// and the excerpt occurs in this version's text. What it does NOT prove: that the number belongs to the
// right item, line or fee, or that conditions and negations around it were read correctly. That stays a
// human review.

import { CURRENT_CHECK_RULES, type ValueCheck } from "../../lib/extraction.ts";
import { QUOTE_CURRENCIES, type QuoteCurrency } from "../../lib/quote.ts";

/** Stored with every result checked by this code (ExtractionResult.checkRules). Change it whenever these rules change. */
export const VALUE_CHECK_RULES = CURRENT_CHECK_RULES;

export type NumberRole = "MONEY" | "COUNT" | "MEASURE" | "PERCENT" | "CODE" | "BARE";

/** value = digits / 10^scale (exact; no floating point). */
export interface Reading {
  digits: bigint;
  scale: number;
}

export interface NumberToken {
  /** Exactly as in the excerpt (e.g. "１，５００"). */
  raw: string;
  /** UTF-16 offsets into the excerpt: excerpt.slice(start, end) === raw. */
  start: number;
  end: number;
  /** NFKC form ("1,500"). */
  normalized: string;
  /** Accepted readings. Empty = unreadable. */
  readings: Reading[];
  /** The format allows more than one reading (or none we accept) — never auto-matched. */
  ambiguousFormat: boolean;
  role: NumberRole;
  /** MONEY: the marker next to the number; "AMBIGUOUS" for a bare $ or ¥. */
  currency: QuoteCurrency | "AMBIGUOUS" | null;
  /** COUNT / MEASURE: the unit as found (normalized). */
  unit: string | null;
}

type ValueFieldType = ValueCheck["field"];
type ValueCheckOutcome = ValueCheck["outcome"];

// ---------- normalisation with a map back to the original ----------

interface Normalized {
  text: string;
  /** For each UTF-16 unit of `text`: [start, end) of the original code point it came from. */
  from: number[];
  to: number[];
  /** The original code point of each unit (to tell an ASCII "," from a full-width "，"). */
  origChar: string[];
}

/** NFKC per code point (full-width digits and punctuation → ASCII), keeping a map to original offsets. */
export function normalizeWithMap(s: string): Normalized {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  const origChar: string[] = [];
  let i = 0;
  for (const ch of s) {
    const n = ch.normalize("NFKC");
    for (let k = 0; k < n.length; k++) {
      from.push(i);
      to.push(i + ch.length);
      origChar.push(ch);
    }
    text += n;
    i += ch.length;
  }
  return { text, from, to, origChar };
}

export const nfkc = (s: string) => s.normalize("NFKC");

// ---------- readings ----------

function reading(intPart: string, frac = ""): Reading {
  return { digits: BigInt(intPart + frac), scale: frac.length };
}

function sameValue(a: Reading, b: Reading): boolean {
  const s = Math.max(a.scale, b.scale);
  const ten = BigInt(10);
  return a.digits * ten ** BigInt(s - a.scale) === b.digits * ten ** BigInt(s - b.scale);
}

/**
 * Readings of a number as written (NFKC, ASCII separators). Accepted without doubt: "1500", "1,500",
 * "1,700.00", "3.20". Ambiguous (could be a European grouping or decimal comma): "1.500", "1,80",
 * "1.800,00", "1.800.000". Anything else (e.g. "1,80,000", "1,5000") is unreadable.
 */
export function readNumber(t: string, commaFromFullWidth = false): { readings: Reading[]; ambiguous: boolean } {
  let m: RegExpExecArray | null;
  if (/^\d+$/.test(t)) return { readings: [reading(t)], ambiguous: false };
  if ((m = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(t))) {
    // A full-width "，" in Chinese text is usually a list separator, not a thousands separator.
    return { readings: [reading(m[1].replace(/,/g, ""), m[2] ?? "")], ambiguous: commaFromFullWidth };
  }
  if ((m = /^(\d{1,3})\.(\d{3})$/.exec(t))) return { readings: [reading(m[1], m[2]), reading(m[1] + m[2])], ambiguous: true };
  if ((m = /^(\d+)\.(\d+)$/.exec(t))) return { readings: [reading(m[1], m[2])], ambiguous: false };
  if ((m = /^(\d{1,3}(?:\.\d{3})+),(\d+)$/.exec(t))) return { readings: [reading(m[1].replace(/\./g, ""), m[2])], ambiguous: true };
  if ((m = /^(\d{1,3}(?:\.\d{3}){2,})$/.exec(t))) return { readings: [reading(m[1].replace(/\./g, ""))], ambiguous: true };
  if ((m = /^(\d+),(\d{1,2})$/.exec(t))) return { readings: [reading(m[1], m[2])], ambiguous: true };
  return { readings: [], ambiguous: true };
}

// ---------- context around a number ----------

const CURRENCY_BEFORE: [RegExp, QuoteCurrency | "AMBIGUOUS"][] = [
  [/(?:US\$|USD|美元|美金)\s?$/i, "USD"],
  [/(?:S\$|SGD|新加坡元|新币)\s?$/i, "SGD"],
  [/(?:CNY|RMB|人民币)\s?$/i, "CNY"],
  [/[$¥]\s?$/, "AMBIGUOUS"],
];
const CURRENCY_AFTER: [RegExp, QuoteCurrency][] = [
  [/^\s?(?:USD|美元|美金)(?![A-Za-z])/i, "USD"],
  [/^\s?(?:SGD|新加坡元|新币)(?![A-Za-z])/i, "SGD"],
  [/^\s?(?:CNY|RMB|人民币|元)(?![A-Za-z])/i, "CNY"],
];
// Checked longest first. "个月" (months) must win over "个" (pieces).
const MEASURE_UNITS = /^\s?(个月|毫升|千克|公斤|毫米|厘米|小时|ml|millilit(?:re|er)s?|lit(?:re|er)s?|ltr|l|kg|mg|g|grams?|mm|cm|km|m|oz|lbs?|inch(?:es)?|in|ft|mah|v|w|hours?|hrs?|days?|weeks?|months?|years?|°c?|"|升|克|米|寸|天|日|周|年|月|小时)(?![A-Za-z])/i;
const COUNT_UNITS = /^\s?(pcs|pc|pieces?|sets?|units?|ctns?|cartons?|box(?:es)?|pairs?|dozens?|ea|bottles?|rolls?|个|件|套|只|台|箱|盒|瓶|双|打|把|张|条|支|片|副)(?![A-Za-z])/i;
const PERCENT_AFTER = /^\s?(?:%|percent(?![A-Za-z])|pct(?![A-Za-z]))/i;
const PERCENT_BEFORE = /百分之\s?$/;
// A label right before the number says it is an identifier, not a quantity or price.
// Deliberately narrow: "Minimum order: 500 pcs" or "per item: 500" are not identifiers.
const CODE_LABEL_BEFORE = /(?:\b(?:no|nr|ref|sku|model|art|p\/n|part\s?no)\.?\s?#?|#|型号|货号|款号|编号|编码|单号|号码)\s?[:：]?\s?$/i;

function currencyCodePrefix(letters: string): QuoteCurrency | null {
  const u = letters.toUpperCase();
  if (u === "USD") return "USD";
  if (u === "SGD") return "SGD";
  if (u === "CNY" || u === "RMB") return "CNY";
  return null;
}

function classify(norm: string, a: number, b: number): Pick<NumberToken, "role" | "currency" | "unit"> {
  const before = norm.slice(Math.max(0, a - 24), a);
  const after = norm.slice(b, b + 24);
  const prev = norm[a - 1] ?? "";
  const prev2 = norm[a - 2] ?? "";
  const next = norm[b] ?? "";
  const next2 = norm[b + 1] ?? "";
  const isAlnum = (c: string) => /[0-9A-Za-z]/.test(c);

  // Part of a code: letters glued in front (unless a currency code), "-", "/", "_" joining alphanumerics,
  // a "#"/"No."/"型号" label, or letters glued after that are not a known unit.
  if (/[A-Za-z]/.test(prev)) {
    const letters = /[A-Za-z]+$/.exec(norm.slice(0, a))![0];
    if (!currencyCodePrefix(letters)) return { role: "CODE", currency: null, unit: null };
  }
  if (/[-_/]/.test(prev) && isAlnum(prev2)) return { role: "CODE", currency: null, unit: null };
  if (/[-_/]/.test(next) && isAlnum(next2)) return { role: "CODE", currency: null, unit: null };
  if (CODE_LABEL_BEFORE.test(before)) return { role: "CODE", currency: null, unit: null };

  if (PERCENT_AFTER.test(after) || PERCENT_BEFORE.test(before)) return { role: "PERCENT", currency: null, unit: null };

  for (const [re, c] of CURRENCY_BEFORE) if (re.test(before)) return { role: "MONEY", currency: c, unit: null };
  for (const [re, c] of CURRENCY_AFTER) if (re.test(after)) return { role: "MONEY", currency: c, unit: null };

  const measure = MEASURE_UNITS.exec(after);
  const count = COUNT_UNITS.exec(after);
  if (measure && (!count || measure[1].length >= count[1].length)) return { role: "MEASURE", currency: null, unit: measure[1].toLowerCase() };
  if (count) return { role: "COUNT", currency: null, unit: count[1].toLowerCase() };
  if (/[A-Za-z]/.test(next)) return { role: "CODE", currency: null, unit: null };
  return { role: "BARE", currency: null, unit: null };
}

/** All number tokens of an excerpt, with digit boundaries (a token never starts or ends inside a longer number). */
export function scanNumbers(excerpt: string): NumberToken[] {
  const n = normalizeWithMap(excerpt);
  const out: NumberToken[] = [];
  const spans: [number, number][] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  for (let m = re.exec(n.text); m !== null; m = re.exec(n.text)) {
    const a = m.index;
    const b = a + m[0].length;
    const commaFromFullWidth = [...m[0]].some((c, k) => c === "," && n.origChar[a + k] !== ",");
    const { readings, ambiguous } = readNumber(m[0], commaFromFullWidth);
    const start = n.from[a];
    const end = n.to[b - 1];
    out.push({ raw: excerpt.slice(start, end), start, end, normalized: m[0], readings, ambiguousFormat: ambiguous, ...classify(n.text, a, b) });
    spans.push([a, b]);
  }
  // "1 500" may be one number grouped with a space (common outside English): both parts are ambiguous.
  for (let k = 1; k < out.length; k++) {
    const gap = n.text.slice(spans[k - 1][1], spans[k][0]);
    if (gap === " " && out[k - 1].role !== "CODE" && /^\d{1,3}$/.test(out[k - 1].normalized) && /^\d{3}(?:[.,]\d+)?$/.test(out[k].normalized)) {
      out[k - 1].ambiguousFormat = true;
      out[k].ambiguousFormat = true;
    }
  }
  return out;
}

// ---------- currencies named anywhere in an excerpt ----------

const CURRENCY_MARKERS: Record<QuoteCurrency, RegExp> = {
  USD: /USD|US\$|美元|美金/i,
  SGD: /SGD|S\$|新加坡元|新币/i,
  CNY: /CNY|RMB|人民币|(?<![美日港新台欧澳加])元/i,
};

/** Currencies named in a piece of text (after NFKC). A bare "$" or "¥" names none (ambiguous). */
export function currenciesIn(text: string): QuoteCurrency[] {
  const t = nfkc(text);
  return QUOTE_CURRENCIES.filter((c) => CURRENCY_MARKERS[c].test(t));
}

// ---------- field checks ----------

const hit = (t: NumberToken) => ({ start: t.start, end: t.end, raw: t.raw });
const result = (field: ValueFieldType, outcome: ValueCheckOutcome, matches: NumberToken[], note: string | null): ValueCheck => ({
  rules: VALUE_CHECK_RULES,
  field,
  outcome,
  matches: matches.map(hit),
  note,
});
const equalTo = (target: Reading) => (t: NumberToken) => t.readings.some((r) => sameValue(r, target));
const ROLE_WORDS: Record<NumberRole, string> = {
  CODE: "part of a code or reference number",
  MEASURE: "a measure (size, weight, capacity or time)",
  MONEY: "an amount of money",
  PERCENT: "a percentage",
  COUNT: "a count",
  BARE: "a plain number",
};

function wrongRoleNote(value: string, tokens: NumberToken[], kind: string): string {
  const roles = [...new Set(tokens.map((t) => ROLE_WORDS[t.role]))];
  return roles.length > 0
    ? `${value} appears in the excerpt only as ${roles.join(" / ")}, not as ${kind}.`
    : `${value} does not appear in the excerpt as a separate number.`;
}

function occurrenceNote(matches: NumberToken[]): string | null {
  return matches.length > 1 ? `The value occurs ${matches.length} times in the excerpt; which one belongs to this field is not checked by code.` : null;
}

/** Quantity "300" as written by the model: must occur as a count or a plain number, not inside a code, measure, amount or percentage. */
export function checkQuantityValue(excerpt: string, value: string, target: number): ValueCheck {
  const goal: Reading = { digits: BigInt(target), scale: 0 };
  const same = scanNumbers(excerpt).filter(equalTo(goal));
  const fitting = same.filter((t) => t.role === "COUNT" || t.role === "BARE");
  const clear = fitting.filter((t) => !t.ambiguousFormat);
  if (clear.length > 0) return result("QUANTITY", "MATCH", clear, occurrenceNote(clear));
  if (fitting.length > 0) return result("QUANTITY", "AMBIGUOUS", fitting, `The number format in the excerpt (${fitting.map((t) => t.raw).join(", ")}) can be read more than one way. Check it against the text.`);
  return result("QUANTITY", "NO_MATCH", [], wrongRoleNote(value.trim(), same, "a quantity"));
}

/** Amount (minor units, parsed from the model's text) in a claimed currency. */
export function checkAmountValue(excerpt: string, amountText: string, minor: number, currency: QuoteCurrency): ValueCheck {
  const goal: Reading = { digits: BigInt(minor), scale: 2 };
  const named = currenciesIn(excerpt);
  const same = scanNumbers(excerpt).filter(equalTo(goal));
  const fitting = same.filter((t) => t.role === "MONEY" || t.role === "BARE");
  const shown = `${currency} ${amountText.trim()}`;

  const clear: NumberToken[] = [];
  const unsure: NumberToken[] = [];
  let otherCurrency = false;
  for (const t of fitting) {
    if (t.role === "MONEY" && t.currency !== "AMBIGUOUS") {
      if (t.currency === currency) (t.ambiguousFormat ? unsure : clear).push(t);
      else otherCurrency = true;
      continue;
    }
    // A bare number or a bare $ / ¥: the excerpt must name exactly one currency, the claimed one.
    if (named.length === 1 && named[0] === currency) (t.ambiguousFormat ? unsure : clear).push(t);
    else if (named.includes(currency)) unsure.push(t);
  }
  if (clear.length > 0) return result("AMOUNT", "MATCH", clear, occurrenceNote(clear));
  if (unsure.length > 0) {
    return result("AMOUNT", "AMBIGUOUS", unsure, named.length > 1 ? `The excerpt names several currencies (${named.join(", ")}); which one applies to ${amountText.trim()} is unclear.` : `The number format in the excerpt can be read more than one way. Check it against the text.`);
  }
  if (otherCurrency) return result("AMOUNT", "NO_MATCH", [], `${amountText.trim()} appears in the excerpt next to a different currency.`);
  if (fitting.length > 0 && !named.includes(currency)) return result("AMOUNT", "NO_MATCH", [], "The excerpt does not name this currency (a bare $ or ¥ is ambiguous).");
  return result("AMOUNT", "NO_MATCH", [], wrongRoleNote(shown, same, "an amount"));
}

/** Percentage "30%" / "30": must occur as a percentage. */
export function checkPercentValue(excerpt: string, value: string): ValueCheck {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*%?\s*$/.exec(nfkc(value));
  if (!m) return result("PERCENT", "NO_MATCH", [], "Not a percentage as written.");
  const goal = reading(m[1], m[2] ?? "");
  const same = scanNumbers(excerpt).filter(equalTo(goal));
  const fitting = same.filter((t) => t.role === "PERCENT");
  const clear = fitting.filter((t) => !t.ambiguousFormat);
  if (clear.length > 0) return result("PERCENT", "MATCH", clear, occurrenceNote(clear));
  if (fitting.length > 0) return result("PERCENT", "AMBIGUOUS", fitting, "The number format in the excerpt can be read more than one way.");
  return result("PERCENT", "NO_MATCH", [], wrongRoleNote(value.trim(), same, "a percentage"));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Text value (name, term, supplier quote number) inside its excerpt: NFKC, case- and whitespace-
 * insensitive, and a value that starts or ends with a digit must not continue a longer number
 * ("QT-118" is not found in "QT-1185"; "30%" is not found in "130%").
 */
export function checkTextValue(excerpt: string, value: string): ValueCheck {
  const hay = squash(nfkc(excerpt)).toLowerCase();
  const needle = squash(nfkc(value)).toLowerCase();
  if (needle === "") return result("TEXT", "NO_MATCH", [], null);
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  let count = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const j = i + needle.length;
    const okStart = !digit(needle[0]) || (!digit(hay[i - 1]) && !(/[.,]/.test(hay[i - 1] ?? "") && digit(hay[i - 2])));
    const okEnd = !digit(needle[needle.length - 1]) || (!digit(hay[j]) && !(/[.,]/.test(hay[j] ?? "") && digit(hay[j + 1])));
    if (okStart && okEnd) count++;
  }
  if (count === 0) return result("TEXT", "NO_MATCH", [], hay.includes(needle) ? "The value appears only as part of a longer number." : null);
  return result("TEXT", "MATCH", [], count > 1 ? `The value occurs ${count} times in the excerpt.` : null);
}
