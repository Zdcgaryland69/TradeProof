// Automated tests for quote comparison: reference extractions of the SYNTHETIC quotes (sources must
// be verbatim), the six seeded discrepancies, no false positives on a matching quote, single-rule cases,
// and the request-text parsers.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ProcurementRecord } from "../src/lib/procurement.ts";
import {
  comparableFromRecord,
  parseIncotermRule,
  parseLogo,
  parseMaterialGrade,
  parsePaymentTerms,
  unverifiedSources,
  type ComparableRequest,
  type ExtractedQuote,
} from "../src/lib/quote.ts";
import { compareQuote, type Finding } from "../src/lib/quote-compare.ts";
import { loadDemoInput } from "../src/server/procurement/demo.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";

const SAMPLES = join("samples", "synthetic");
const read = (name: string) => readFileSync(join(SAMPLES, name), "utf8");
const json = <T>(name: string) => JSON.parse(read(name)) as T;

const zh = () => json<ExtractedQuote>("extracted-quote-zh.synthetic.json");
const en = () => json<ExtractedQuote>("extracted-quote-en.synthetic.json");
const expected = json<{ findings: { field: string; type: string; severity: string }[] }>("expected-discrepancies.synthetic.json");

let dir: string;
let demoRecord: ProcurementRecord;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-quote-test-"));
  const input = loadDemoInput();
  assert.ok(input, "demo sample must load");
  const v = validateProcurementInput(input);
  assert.ok(v.ok);
  const store = new ProcurementStore(join(dir, "app.sqlite"));
  demoRecord = store.create(v.value, "DEMO_SAMPLE");
  store.close();
});
after(() => rmSync(dir, { recursive: true, force: true }));

const demoRequest = (): ComparableRequest => comparableFromRecord(demoRecord);
const key = (f: { field: string; type: string; severity: string }) => `${f.field}|${f.type}|${f.severity}`;
const types = (fs: Finding[]) => fs.map((f) => f.type).sort();

/** The English quote with every value aligned to the demo request. */
function matchingQuote(): ExtractedQuote {
  const q = en();
  const s = <T>(value: T) => ({ value, source: "x" });
  q.items[0].materialGrade = s("304");
  q.items[0].logo = s({ method: "LASER_ENGRAVING" as const, colours: 1 });
  q.total = s({ currency: "USD" as const, minor: 170_000 });
  q.leadTime = s({ days: 30, basis: "AFTER_DEPOSIT" as const, approximate: false });
  return q;
}

describe("reference extractions (SYNTHETIC)", () => {
  test("are marked synthetic and every source is verbatim document text", () => {
    for (const [quote, doc] of [
      [zh(), "supplier-quote-zh.synthetic.md"],
      [en(), "supplier-quote-en.synthetic.md"],
    ] as const) {
      assert.match(quote._notice ?? "", /SYNTHETIC/);
      assert.equal(quote.documentId, doc);
      assert.deepEqual(unverifiedSources(read(doc), quote), []);
    }
  });

  test("a source the document does not contain is rejected", () => {
    const q = zh();
    q.items[0].quantity = { value: 500, source: "| 数量 | 500 个 |" };
    assert.deepEqual(unverifiedSources(read("supplier-quote-zh.synthetic.md"), q), ["items[0].quantity"]);
  });

  test("a value stated without any source is rejected", () => {
    const q = en();
    q.total = { value: { currency: "USD", minor: 170_000 }, source: null };
    assert.deepEqual(unverifiedSources(read("supplier-quote-en.synthetic.md"), q), ["total"]);
  });

  test("source check ignores whitespace differences only", () => {
    const q = en();
    q.items[0].quantity.source = "-   Quantity:\n500 pcs";
    assert.deepEqual(unverifiedSources(read("supplier-quote-en.synthetic.md"), q), []);
    q.items[0].quantity.source = "- Quantity: 500pcs";
    assert.deepEqual(unverifiedSources(read("supplier-quote-en.synthetic.md"), q), ["items[0].quantity"]);
  });
});

describe("demo request → comparable form", () => {
  test("parses the demo request fields", () => {
    const r = demoRequest();
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].materialGrade, "304");
    assert.deepEqual(r.items[0].logo, { method: "LASER_ENGRAVING", colours: 1 });
    assert.equal(r.items[0].quantity, 500);
    assert.deepEqual(r.budget, { currency: "USD", minor: 180_000 });
    assert.equal(r.incotermRule, "FOB");
    assert.deepEqual(r.paymentTerms, { depositPercent: 30, balanceTiming: "BEFORE_SHIPMENT" });
    assert.equal(r.requiredShipDate, "2026-12-10");
  });
});

describe("seeded discrepancies (samples/synthetic/expected-discrepancies.synthetic.json)", () => {
  const run = () => compareQuote(demoRequest(), [zh(), en()], { asOf: "2026-10-23" });

  test("all 6 expected findings are detected, with no other findings", () => {
    const got = run();
    assert.equal(expected.findings.length, 6);
    assert.deepEqual(got.map(key).sort(), expected.findings.map(key).sort());
  });

  test("each finding shows the request text and, per document, the value and its source", () => {
    for (const f of run()) {
      assert.ok(f.request, `${f.field} has request text`);
      const docs = new Set(f.quotes.map((e) => e.documentId));
      assert.ok(docs.has("supplier-quote-zh.synthetic.md") && docs.has("supplier-quote-en.synthetic.md"), f.field);
      for (const e of f.quotes) {
        if (e.source !== null) assert.ok(read(e.documentId).includes(e.source), `${f.field}: source is verbatim`);
      }
    }
  });

  test("specific evidence: grade not stated in English, laser surcharge, deposit deadline", () => {
    const by = Object.fromEntries(run().map((f) => [f.field, f]));
    assert.deepEqual(by.material.quotes.map((e) => e.value), ["grade 201", "not stated"]);
    assert.match(by.logo.summary, /CNY 1\.20 per unit/);
    assert.ok(by.logo.quotes.some((e) => e.source === "激光雕刻 Logo 每个另加人民币 1.20 元。"));
    assert.match(by.currency_and_amount.summary, /CNY and USD/);
    assert.match(by.lead_time.summary, /deposit must be paid by 2026-11-05/);
    assert.match(by.payment_terms.summary, /50% deposit.*30% deposit/);
  });

  test("high-severity findings come first; inputs are not changed", () => {
    const quotes = [zh(), en()];
    const before = JSON.stringify(quotes);
    const got = compareQuote(demoRequest(), quotes, { asOf: "2026-10-23" });
    assert.equal(JSON.stringify(quotes), before);
    const ranks = got.map((f) => ({ high: 0, medium: 1, low: 2 })[f.severity]);
    assert.deepEqual(ranks, [...ranks].sort());
    assert.deepEqual(got, compareQuote(demoRequest(), [zh(), en()], { asOf: "2026-10-23" }));
  });
});

describe("single rules", () => {
  test("a quote that matches the request gives no findings", () => {
    assert.deepEqual(compareQuote(demoRequest(), [matchingQuote()], { asOf: "2026-10-23" }), []);
  });

  test("no quotes → no findings", () => {
    assert.deepEqual(compareQuote(demoRequest(), []), []);
  });

  test("quantity differs from request (one document)", () => {
    const q = matchingQuote();
    q.items[0].quantity.value = 480;
    q.total.value = { currency: "USD", minor: 163_200 };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["quantity_mismatch"]);
  });

  test("payment terms differ from accepted terms (one document)", () => {
    const q = matchingQuote();
    q.paymentTerms.value = { depositPercent: 50, balanceTiming: "BEFORE_SHIPMENT" };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["payment_terms_mismatch"]);
    q.paymentTerms.value = { depositPercent: 30, balanceTiming: "AFTER_SHIPMENT" };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["payment_terms_mismatch"]);
  });

  test("over budget in the budget currency", () => {
    const q = matchingQuote();
    q.items[0].unitPrice.value = { currency: "USD", minor: 361 };
    q.total.value = { currency: "USD", minor: 180_500 };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["over_budget"]);
  });

  test("exactly at budget is not over budget", () => {
    const q = matchingQuote();
    q.items[0].unitPrice.value = { currency: "USD", minor: 360 };
    q.total.value = { currency: "USD", minor: 180_000 };
    assert.deepEqual(compareQuote(demoRequest(), [q]), []);
  });

  test("over budget without a stated total uses unit price × quantity", () => {
    const q = matchingQuote();
    q.items[0].unitPrice.value = { currency: "USD", minor: 361 };
    q.total = { value: null, source: null };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["over_budget"]);
  });

  test("stated total ≠ unit price × quantity", () => {
    const q = matchingQuote();
    q.total.value = { currency: "USD", minor: 160_000 };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["total_arithmetic_mismatch"]);
  });

  test("a different currency from the budget needs confirmation (no conversion)", () => {
    const q = matchingQuote();
    q.items[0].unitPrice.value = { currency: "SGD", minor: 400 };
    q.total.value = { currency: "SGD", minor: 200_000 };
    const got = compareQuote(demoRequest(), [q]);
    assert.deepEqual(types(got), ["currency_mismatch_needs_confirmation"]);
  });

  test("incoterm rule differs", () => {
    const q = matchingQuote();
    q.incoterm.value = { rule: "EXW", place: "Ningbo" };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["incoterm_mismatch"]);
  });

  test("lead time too late only when asOf is given", () => {
    const q = matchingQuote();
    q.leadTime.value = { days: 60, basis: "AFTER_DEPOSIT", approximate: false };
    assert.deepEqual(compareQuote(demoRequest(), [q]), []);
    // 2026-10-23 + 60 days = 2026-12-22 > 2026-12-10
    const got = compareQuote(demoRequest(), [q], { asOf: "2026-10-23" });
    assert.deepEqual(types(got), ["lead_time_too_late"]);
    assert.match(got[0].summary, /2026-12-22/);
    // 2026-10-11 + 60 days = 2026-12-10 → still on time
    assert.deepEqual(compareQuote(demoRequest(), [q], { asOf: "2026-10-11" }), []);
  });

  test("grade or logo not stated → spec_not_stated", () => {
    const q = matchingQuote();
    q.items[0].materialGrade.value = null;
    q.items[0].logo = { value: null, source: null };
    const got = compareQuote(demoRequest(), [q]);
    assert.deepEqual(got.map((f) => `${f.field}:${f.type}`).sort(), ["logo:spec_not_stated", "material:spec_not_stated"]);
  });

  test("logo colours differ", () => {
    const q = matchingQuote();
    q.items[0].logo.value = { method: "LASER_ENGRAVING", colours: 2 };
    assert.deepEqual(types(compareQuote(demoRequest(), [q])), ["spec_mismatch"]);
  });

  test("unrecognised request wording → cannot_compare, never a silent pass", () => {
    const r = demoRequest();
    r.items[0].materialGrade = null;
    r.items[0].materialText = "food-grade steel";
    r.paymentTerms = null;
    r.paymentTermsText = "as usual";
    const got = compareQuote(r, [matchingQuote()]);
    assert.deepEqual(got.map((f) => `${f.field}:${f.type}:${f.severity}`).sort(), ["material:cannot_compare:low", "payment_terms:cannot_compare:low"]);
  });

  test("different item count is reported", () => {
    const q = matchingQuote();
    q.items.push(structuredClone(q.items[0]));
    q.total.value = { currency: "USD", minor: 340_000 };
    assert.ok(types(compareQuote(demoRequest(), [q])).includes("item_count_mismatch"));
  });
});

describe("request text parsers", () => {
  test("material grade", () => {
    assert.equal(parseMaterialGrade("304 stainless steel"), "304");
    assert.equal(parseMaterialGrade("SUS304"), "304");
    assert.equal(parseMaterialGrade("316l stainless"), "316L");
    assert.equal(parseMaterialGrade("201 不锈钢"), "201");
    assert.equal(parseMaterialGrade("3040 alloy"), null);
    assert.equal(parseMaterialGrade("stainless steel"), null);
    assert.equal(parseMaterialGrade(null), null);
  });

  test("logo", () => {
    assert.deepEqual(parseLogo("Logo: Laser engraving, 1 colour"), { method: "LASER_ENGRAVING", colours: 1 });
    assert.deepEqual(parseLogo("丝印 1 色"), { method: "SCREEN_PRINT", colours: 1 });
    assert.deepEqual(parseLogo("printed, 2 colors"), { method: "PRINT_UNSPECIFIED", colours: 2 });
    assert.deepEqual(parseLogo("silk-screen print"), { method: "SCREEN_PRINT", colours: null });
    assert.equal(parseLogo("nice logo please"), null);
  });

  test("payment terms", () => {
    assert.deepEqual(parsePaymentTerms("30% deposit, 70% before shipment"), { depositPercent: 30, balanceTiming: "BEFORE_SHIPMENT" });
    assert.deepEqual(parsePaymentTerms("50% 定金，50% 发货前付清"), { depositPercent: 50, balanceTiming: "BEFORE_SHIPMENT" });
    assert.deepEqual(parsePaymentTerms("Deposit 40%, balance against B/L copy"), { depositPercent: 40, balanceTiming: "AFTER_SHIPMENT" });
    assert.deepEqual(parsePaymentTerms("20% deposit"), { depositPercent: 20, balanceTiming: null });
    assert.equal(parsePaymentTerms("net 30"), null);
    assert.equal(parsePaymentTerms("150% deposit"), null);
  });

  test("incoterm", () => {
    assert.equal(parseIncotermRule("China (FOB Ningbo)"), "FOB");
    assert.equal(parseIncotermRule("cif singapore"), "CIF");
    assert.equal(parseIncotermRule("Shenzhen"), null);
  });
});
