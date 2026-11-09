// Number-aware value checks (25 Oct fix of the 24 Oct substring defect). Expected results are written
// by hand. Run: npm test

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEGACY_CHECK_RULES, checkRulesOf, type ExtractionResult } from "../src/lib/extraction.ts";
import { checkExtraction, resultStatus, toComparatorQuote, type ModelOutput } from "../src/server/extraction/check.ts";
import { VALUE_CHECK_RULES, checkAmountValue, checkPercentValue, checkQuantityValue, checkTextValue, scanNumbers } from "../src/server/extraction/numbers.ts";

const qty = (excerpt: string, v: number) => checkQuantityValue(excerpt, String(v), v);
const usd = (excerpt: string, text: string, minor: number) => checkAmountValue(excerpt, text, minor, "USD");

describe("quantities: digit boundaries and role", () => {
  test("500 is not found in 1500 / 1,500 / 15000; it is found as 500", () => {
    assert.equal(qty("1500 pcs", 500).outcome, "NO_MATCH");
    assert.equal(qty("1,500 pcs", 500).outcome, "NO_MATCH");
    assert.equal(qty("15000 pcs", 500).outcome, "NO_MATCH");
    assert.equal(qty("5000个", 500).outcome, "NO_MATCH");
    assert.equal(qty("500 pcs", 500).outcome, "MATCH");
  });

  test("units next to the number: 500pcs / 500 个 / 500个 / 500 sets are counts", () => {
    for (const e of ["500pcs", "500 个", "500个", "500 sets", "Qty: 500", "数量：500件"]) assert.equal(qty(e, 500).outcome, "MATCH", e);
  });

  test("a measure is not a quantity: 500ml, 500 ml, 500毫升, 40 days, 3个月", () => {
    for (const e of ["bottle 500ml", "bottle 500 ml", "500毫升", "500 g"]) {
      const r = qty(e, 500);
      assert.equal(r.outcome, "NO_MATCH", e);
      assert.match(r.note ?? "", /measure/, e);
    }
    assert.equal(qty("40 days after deposit", 40).outcome, "NO_MATCH");
    assert.equal(qty("交期3个月", 3).outcome, "NO_MATCH", "个月 = months, not 个 = pieces");
  });

  test("numbers inside product / item codes are never quantity evidence", () => {
    for (const e of ["Model BT-500, 300 pcs", "BT500 300 pcs", "型号 500，数量 300 个", "Item No. 500: 300 pcs", "#500 300 pcs", "SKU 500 / 300 pcs", "500A 300 pcs"]) {
      const r = qty(e, 500);
      assert.equal(r.outcome, "NO_MATCH", e);
      assert.match(r.note ?? "", /code/, e);
      assert.equal(qty(e, 300).outcome, "MATCH", `${e} → 300`);
    }
  });

  test("an amount or percentage is not a quantity", () => {
    assert.equal(qty("unit price USD 300", 300).outcome, "NO_MATCH");
    assert.equal(qty("30% deposit", 30).outcome, "NO_MATCH");
  });

  test("full-width digits: matched, and the original characters and offsets are kept", () => {
    const excerpt = "数量：５００ 件";
    const r = qty(excerpt, 500);
    assert.equal(r.outcome, "MATCH");
    assert.equal(r.matches.length, 1);
    const m = r.matches[0];
    assert.equal(m.raw, "５００");
    assert.equal(excerpt.slice(m.start, m.end), "５００");
  });

  test("ambiguous formats stay for the user: 1.500 pcs, 1 500 pcs, full-width comma １，５００", () => {
    assert.equal(qty("1.500 pcs", 1500).outcome, "AMBIGUOUS");
    assert.equal(qty("1 500 pcs", 500).outcome, "AMBIGUOUS", "may be one number grouped with a space");
    assert.equal(qty("１，５００ pcs", 1500).outcome, "AMBIGUOUS", "full-width comma is often a list separator");
    assert.equal(qty("1,500 pcs", 1500).outcome, "MATCH", "ASCII thousands separator");
  });

  test("a value occurring twice is a match with both places listed and a note", () => {
    const r = qty("500 pcs black, 500 pcs white", 500);
    assert.equal(r.outcome, "MATCH");
    assert.equal(r.matches.length, 2);
    assert.match(r.note ?? "", /2 times/);
  });
});

describe("amounts: value, format and currency", () => {
  test("USD 3.20 is not found in USD 13.20 or USD 3.205; 3.2 = 3.20", () => {
    assert.equal(usd("USD 13.20", "3.20", 320).outcome, "NO_MATCH");
    assert.equal(usd("USD 3.205", "3.20", 320).outcome, "NO_MATCH");
    assert.equal(usd("USD 3.20", "3.2", 320).outcome, "MATCH");
    assert.equal(usd("USD 3.2", "3.20", 320).outcome, "MATCH");
    assert.equal(usd("USD3.20", "3.20", 320).outcome, "MATCH", "currency code glued to the number");
  });

  test("thousands separators: 1,700.00 = 1700.00 both ways", () => {
    assert.equal(usd("Total USD 1700.00", "1,700.00", 170000).outcome, "MATCH");
    assert.equal(usd("Total USD 1,700.00", "1700.00", 170000).outcome, "MATCH");
    assert.equal(usd("Total USD 11,700.00", "1,700.00", 170000).outcome, "NO_MATCH");
  });

  test("full-width amount and currency", () => {
    const r = usd("单价 ＵＳＤ ３．２０", "3.20", 320);
    assert.equal(r.outcome, "MATCH");
    assert.equal(r.matches[0].raw, "３．２０");
  });

  test("European formats are ambiguous, never parsed as a guess", () => {
    assert.equal(usd("USD 1.800,00", "1800.00", 180000).outcome, "AMBIGUOUS");
    assert.equal(usd("USD 3,20", "3.20", 320).outcome, "AMBIGUOUS");
  });

  test("currency: must be next to the number or the only one named; $ alone names none; two currencies → ambiguous", () => {
    assert.equal(usd("Unit price (USD): $3.20", "3.20", 320).outcome, "MATCH");
    assert.equal(usd("$3.20", "3.20", 320).outcome, "NO_MATCH");
    assert.equal(usd("SGD 25.00", "25.00", 2500).outcome, "NO_MATCH");
    assert.equal(usd("Prices in USD or SGD: 25.00", "25.00", 2500).outcome, "AMBIGUOUS");
    assert.equal(usd("USD 25.00 (about SGD 32.50)", "25.00", 2500).outcome, "MATCH", "explicit marker next to the number");
    assert.equal(checkAmountValue("人民币 24.50 元", "24.50", 2450, "CNY").outcome, "MATCH");
    assert.equal(checkAmountValue("3.40 美元", "3.40", 340, "CNY").outcome, "NO_MATCH", "美元 is USD, not CNY");
  });

  test("a count, a percentage or a code is not an amount", () => {
    assert.equal(usd("300 pcs @ USD 3.20", "300", 30000).outcome, "NO_MATCH");
    assert.equal(usd("30% of USD 1,000", "30", 3000).outcome, "NO_MATCH");
    assert.equal(usd("PI-2500, USD 900", "2500", 250000).outcome, "NO_MATCH");
  });
});

describe("percentages and text values", () => {
  test("percentage must be a percentage; 30% is not inside 130%", () => {
    assert.equal(checkPercentValue("30% deposit 70% before shipment", "30%").outcome, "MATCH");
    assert.equal(checkPercentValue("30 ％ 定金", "30").outcome, "MATCH");
    assert.equal(checkPercentValue("130% markup", "30%").outcome, "NO_MATCH");
    assert.equal(checkPercentValue("30 pcs", "30%").outcome, "NO_MATCH");
  });

  test("text: digit boundaries for numbers at the edges; NFKC; case-insensitive", () => {
    assert.equal(checkTextValue("Quotation No. QT-1185", "QT-118").outcome, "NO_MATCH");
    assert.equal(checkTextValue("Quotation No. QT-118.", "QT-118").outcome, "MATCH");
    assert.equal(checkTextValue("报价单号：ＱＴ－１１８", "QT-118").outcome, "MATCH");
    assert.equal(checkTextValue("130% markup", "30%").outcome, "NO_MATCH");
    assert.equal(checkTextValue("Stainless steel bottle", "stainless STEEL").outcome, "MATCH");
  });

  test("scanNumbers keeps raw text and roles", () => {
    const toks = scanNumbers("300 pcs @ USD 3.20 = USD 960.00, BT-500, 500ml, 30%");
    assert.deepEqual(
      toks.map((t) => [t.raw, t.role]),
      [["300", "COUNT"], ["3.20", "MONEY"], ["960.00", "MONEY"], ["500", "CODE"], ["500", "MEASURE"], ["30", "PERCENT"]],
    );
  });
});

// ---------- in the full check ----------

const T = (value: string | null, quote: string | null = value) => ({ value, quote });
const M = (amount: string | null, currency: string | null, quote: string | null) => ({ amount, currency, quote });
const NONE = { value: null, quote: null };
const NO_MONEY = { amount: null, currency: null, quote: null };
function output(over: Partial<ModelOutput> = {}): ModelOutput {
  return { supplierQuoteNumbers: [], quoteDate: NONE, currency: NONE, items: [], total: NO_MONEY, incoterm: NONE, leadTime: NONE, paymentTerms: NONE, fees: [], ...over };
}
const item = (over: Partial<ModelOutput["items"][number]>) => ({ name: NONE, quantity: NONE, unit: NONE, material: NONE, specification: NONE, logo: NONE, unitPrice: NO_MONEY, requestItemCandidates: [], ...over });
const TEXT = "Bottle 500ml — 1500 pcs @ USD 13.20\nTotal: USD 19,800.00";

describe("checkExtraction uses the new rules", () => {
  test("500 against '1500 pcs' and USD 3.20 against 'USD 13.20' are not saved as facts; the run is INCOMPLETE", () => {
    const r = checkExtraction(output({ items: [item({ quantity: T("500", "1500 pcs @ USD 13.20"), unitPrice: M("3.20", "USD", "1500 pcs @ USD 13.20") })] }), {
      text: TEXT,
      contextText: null,
      contentKind: "FULL_QUOTE",
      snapshotItemIds: new Set(),
    });
    assert.equal(r.checkRules, VALUE_CHECK_RULES);
    assert.equal(r.items[0].quantity.check, "VALUE_NOT_IN_EXCERPT");
    assert.equal(r.items[0].quantity.value, null);
    assert.equal(r.items[0].unitPrice.check, "VALUE_NOT_IN_EXCERPT");
    assert.equal(r.items[0].unitPrice.value, null);
    assert.equal(resultStatus(r), "INCOMPLETE");
    // The excerpt is kept exactly as stored, with its position.
    assert.equal(r.items[0].quantity.evidence!.excerpt, "1500 pcs @ USD 13.20");
    assert.equal(TEXT.slice(r.items[0].quantity.evidence!.start, r.items[0].quantity.evidence!.end), "1500 pcs @ USD 13.20");
  });

  test("a quantity cited from '500ml' is rejected; correct values pass and record their value check", () => {
    const r = checkExtraction(
      output({ items: [item({ quantity: T("500", "Bottle 500ml"), unitPrice: M("13.20", "USD", "@ USD 13.20") })], total: M("19800.00", "USD", "Total: USD 19,800.00") }),
      { text: TEXT, contextText: null, contentKind: "FULL_QUOTE", snapshotItemIds: new Set() },
    );
    assert.equal(r.items[0].quantity.check, "VALUE_NOT_IN_EXCERPT");
    assert.equal(r.items[0].unitPrice.check, "SUPPORTED");
    assert.equal(r.items[0].unitPrice.valueCheck?.field, "AMOUNT");
    assert.equal(r.total.check, "SUPPORTED");
    assert.equal(r.total.value?.minor, 1_980_000);
  });

  test("an ambiguous number format → AMBIGUOUS_VALUE (counts as a problem), never a guessed value", () => {
    const text = "Total: USD 1.800,00";
    const r = checkExtraction(output({ total: M("1800.00", "USD", "Total: USD 1.800,00") }), { text, contextText: null, contentKind: "FULL_QUOTE", snapshotItemIds: new Set() });
    assert.equal(r.total.check, "AMBIGUOUS_VALUE");
    assert.equal(r.total.value, null);
    assert.equal(r.counts.AMBIGUOUS_VALUE, 1);
    assert.equal(resultStatus(r), "INCOMPLETE");
  });

  test("scope limit (documented): a value cited from another item's line is still SUPPORTED — code does not check which item it belongs to", () => {
    const text = "1) Bottle A — 300 pcs @ USD 3.20\n2) Bottle B — 200 pcs @ USD 3.80";
    const r = checkExtraction(output({ items: [item({ name: T("Bottle B", "2) Bottle B"), quantity: T("300", "300 pcs @ USD 3.20") })] }), { text, contextText: null, contentKind: "FULL_QUOTE", snapshotItemIds: new Set() });
    assert.equal(r.items[0].quantity.check, "SUPPORTED", "only a person can tell this belongs to Bottle A");
  });

  test("older results keep their actual scope: no checkRules → legacy rules; never fed to the comparator", () => {
    const fresh = checkExtraction(output(), { text: TEXT, contextText: null, contentKind: "FULL_QUOTE", snapshotItemIds: new Set() });
    const legacy = { ...fresh, schemaVersion: "extraction-result-1" } as ExtractionResult;
    delete legacy.checkRules;
    assert.equal(checkRulesOf(legacy), LEGACY_CHECK_RULES);
    assert.equal(checkRulesOf(fresh), VALUE_CHECK_RULES);
    assert.equal(toComparatorQuote(legacy, "d", "en"), null);
    assert.notEqual(toComparatorQuote(fresh, "d", "en"), null);
  });
});
