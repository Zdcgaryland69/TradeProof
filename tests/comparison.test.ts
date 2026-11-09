// Comparator wired to stored extraction runs (26 Oct; acceptance rows C1–C7, design §8). No model is
// called anywhere in this file:
//   - pure tests use the five STORED real-model runs exactly as stored on 25 Oct (exported read-only to
//     samples/synthetic/live-acceptance/stored-runs.synthetic.json), with request snapshots and reviews
//     changed only in memory;
//   - service / HTTP tests use temporary databases and a counting test double that replays stored output.
// Expected outcomes are written by hand from the sample texts.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { en } from "../src/i18n/en.ts";
import {
  COMPARATOR_VERSION,
  compareExtraction,
  looksNotAgreed,
  readMoney,
  runRefusal,
  userConfirmedMatches,
  type Comparison,
  type ComparisonInput,
  type VersionFacts,
} from "../src/lib/comparison.ts";
import { CURRENT_CHECK_RULES, type ExtractionResult, type ExtractionReview, type ExtractionRun, type ReviewAction } from "../src/lib/extraction.ts";
import { emptyInput, type ProcurementInput } from "../src/lib/procurement.ts";
import type { RequestSnapshot } from "../src/lib/quote-versions.ts";
import { handleComparison } from "../src/server/comparison/http.ts";
import { ComparisonService, singaporeDay } from "../src/server/comparison/service.ts";
import { checkExtraction, type ModelOutput } from "../src/server/extraction/check.ts";
import type { ExtractionModel, ModelReply, ResolvedModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { BudgetStore } from "../src/server/budget/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { generousBudget } from "./helpers/budget.ts";
import { testBuyer, testGate } from "./helpers/principals.ts";

// ---------------------------------------------------------------- stored runs (read-only fixture)

interface StoredVersion extends Omit<VersionFacts, "computedSha256"> {
  rawText: string;
}
interface StoredCase {
  title: string;
  version: StoredVersion;
  base: StoredVersion | null;
  run: ExtractionRun;
}
const STORED = JSON.parse(readFileSync(join("samples", "synthetic", "live-acceptance", "stored-runs.synthetic.json"), "utf8")) as { cases: Record<string, StoredCase> };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const clone = <T>(v: T): T => structuredClone(v);

function facts(v: StoredVersion): VersionFacts {
  const { rawText, ...rest } = v;
  return { ...clone(rest), computedSha256: sha(rawText) };
}

/** A stored case as comparator input; `edit` changes copies only. */
function stored(key: string, edit: (i: ComparisonInput) => void = () => {}): ComparisonInput {
  const c = STORED.cases[key];
  const input: ComparisonInput = {
    version: facts(c.version),
    run: clone(c.run),
    reviews: [],
    currentRequestRevision: c.version.requestRevision,
    base: c.base ? { version: facts(c.base), run: null, reviews: [] } : null,
    asOf: "2026-10-26",
  };
  edit(input);
  return input;
}

let reviewSeq = 0;
function review(runId: string, fieldPath: string, action: ReviewAction, extra: { valueText?: string; requestItemId?: string } = {}): ExtractionReview {
  reviewSeq += 1;
  return {
    id: `qxr_00000000-0000-4000-8000-${String(reviewSeq).padStart(12, "0")}`,
    extractionId: runId,
    fieldPath,
    action,
    valueText: extra.valueText ?? null,
    requestItemId: extra.requestItemId ?? null,
    supersedesId: null,
    createdAt: new Date(Date.UTC(2026, 9, 26, 3, 0, reviewSeq)).toISOString(),
  };
}

const rows = (c: Comparison, field: string) => c.rows.filter((r) => r.field === field);
const row = (c: Comparison, field: string, requestItemId: string | null = null) => {
  const found = c.rows.filter((r) => r.field === field && (requestItemId === null || r.requestItemId === requestItemId));
  assert.equal(found.length, 1, `${field} rows: ${JSON.stringify(found.map((r) => r.note))}`);
  return found[0];
};
const snapItems = (i: ComparisonInput) => i.version.snapshot.record.items;
const record = (i: ComparisonInput) => i.version.snapshot.record as RequestSnapshot["record"] & Record<string, unknown>;

// ---------------------------------------------------------------- C1 binding

describe("C1 — exact binding to version, hash, snapshot revision, run and rules", () => {
  test("LA-1: every part of the basis is named and taken from the stored run and version", () => {
    const input = stored("LA-1");
    const c = compareExtraction(input);
    const lc = STORED.cases["LA-1"];
    assert.equal(c.binding.version.id, lc.version.id);
    assert.equal(c.binding.version.rawTextSha256, lc.version.rawTextSha256);
    assert.equal(c.binding.snapshotRevision, 1);
    assert.equal(c.binding.run.id, lc.run.id);
    assert.equal(c.binding.run.checkRules, CURRENT_CHECK_RULES);
    assert.equal(c.binding.run.mode, "LIVE");
    assert.equal(c.binding.comparatorVersion, COMPARATOR_VERSION);
    assert.equal(c.binding.requestUpdated, false);
    // Every value shown comes from that run (no field from another run is mixed in).
    for (const r of c.rows) for (const q of r.quote) assert.equal(q.runId, lc.run.id);
    assert.equal(row(c, "quantity").outcome, "MATCH");
    assert.equal(row(c, "material").outcome, "MATCH"); // "304 stainless steel" on both sides
    assert.equal(row(c, "arithmetic").note.code, "TOTAL_MATCHES_LINES");
  });

  test("refusals: other version, changed text, other run hash, other snapshot revision, unfinished, older rules, wrong supplement base", () => {
    const base = stored("LA-1");
    const refuse = (edit: (i: ComparisonInput) => void) => {
      const i = stored("LA-1", edit);
      return runRefusal(i.run, i.version);
    };
    assert.equal(runRefusal(base.run, base.version), null);
    assert.equal(refuse((i) => (i.run.versionId = STORED.cases["LA-3"].version.id)), "RUN_NOT_FOR_VERSION");
    assert.equal(refuse((i) => (i.run.requestId = STORED.cases["LA-3"].run.requestId)), "RUN_NOT_FOR_VERSION");
    assert.equal(refuse((i) => (i.version.computedSha256 = sha(STORED.cases["LA-1"].version.rawText + " "))), "TEXT_HASH_MISMATCH");
    assert.equal(refuse((i) => (i.run.inputSha256 = sha("other text"))), "RUN_HASH_MISMATCH");
    assert.equal(refuse((i) => (i.run.requestRevision = 2)), "SNAPSHOT_REVISION_MISMATCH");
    assert.equal(refuse((i) => (i.run.status = "FAILED")), "RUN_NOT_FINISHED");
    assert.equal(refuse((i) => (i.run.status = "RUNNING")), "RUN_NOT_FINISHED");
    assert.equal(refuse((i) => delete (i.run.result as Partial<ExtractionResult>).checkRules), "LEGACY_RULES");
    assert.equal(refuse((i) => ((i.run.result as ExtractionResult).checkRules = "value-check-2026-10-24.0-substring")), "LEGACY_RULES");
    const sup = stored("LA-4");
    assert.equal(runRefusal(sup.run, sup.version), null);
    const wrongBase = stored("LA-4", (i) => (i.run.contextVersionId = "qv_00000000-0000-4000-8000-000000000000"));
    assert.equal(runRefusal(wrongBase.run, wrongBase.version), "CONTEXT_MISMATCH");
  });

  test("a changed current request is reported; the snapshot saved with the version stays the basis", () => {
    const c = compareExtraction(stored("LA-1", (i) => (i.currentRequestRevision = 3)));
    assert.equal(c.binding.requestUpdated, true);
    assert.equal(c.binding.snapshotRevision, 1);
    assert.equal(c.binding.currentRequestRevision, 3);
    assert.equal(row(c, "quantity").requestText, "200 pcs"); // from the snapshot, not today's request
  });
});

// ---------------------------------------------------------------- C2 pairing by stable ids

describe("C2 — items paired by stable line ids, never by position", () => {
  const LA3 = STORED.cases["LA-3"];
  const [LUNCH, CUTLERY] = LA3.version.snapshot.record.items.map((i) => i.id);

  test("LA-3 with request lines AND quote items reordered: same pairs, model proposals labelled as such", () => {
    const normal = compareExtraction(stored("LA-3"));
    const reordered = compareExtraction(
      stored("LA-3", (i) => {
        const items = snapItems(i);
        items.reverse();
        items.forEach((it, n) => (it.position = n + 1));
        (i.run.result as ExtractionResult).items.reverse();
      }),
    );
    for (const c of [normal, reordered]) {
      assert.equal(row(c, "quantity", LUNCH).requestText, "300 sets");
      assert.equal(row(c, "quantity", LUNCH).quote[0].used, "300");
      assert.equal(row(c, "quantity", CUTLERY).quote[0].used, "600");
      assert.ok(rows(c, "quantity").every((r) => r.outcome === "MATCH" && r.provisionalPairing));
      assert.ok(c.pairings.every((p) => p.status === "PROPOSED"));
    }
    // The quote index moved, the pairing did not.
    assert.equal(row(reordered, "quantity", LUNCH).quoteItemIndex, 1);
    assert.equal(row(normal, "quantity", LUNCH).quoteItemIndex, 0);
  });

  test("the user's choice wins over position and over the proposal; two items on one line are not compared", () => {
    const runId = LA3.run.id;
    const confirmed = compareExtraction(stored("LA-3", (i) => (i.reviews = [review(runId, "items[0].match", "MATCH_ITEM", { requestItemId: LUNCH })])));
    assert.equal(confirmed.pairings[0].status, "CONFIRMED");
    assert.equal(row(confirmed, "quantity", LUNCH).provisionalPairing, false);
    assert.equal(row(confirmed, "quantity", CUTLERY).provisionalPairing, true);

    // User pairs the 300-set lunch box quote item with the cutlery line: compared as the user said (300 ≠ 600),
    // and the model's own proposal for item 2 on the same line makes both a conflict.
    const crossed = compareExtraction(stored("LA-3", (i) => (i.reviews = [review(runId, "items[0].match", "MATCH_ITEM", { requestItemId: CUTLERY })])));
    assert.deepEqual(
      crossed.pairings.map((p) => p.status),
      ["CONFLICT", "CONFLICT"],
    );
    assert.equal(rows(crossed, "quantity").length, 0);
    assert.equal(row(crossed, "pairing", LUNCH).note.code, "NOT_QUOTED");
    const crossedOnly = compareExtraction(
      stored("LA-3", (i) => (i.reviews = [review(runId, "items[0].match", "MATCH_ITEM", { requestItemId: CUTLERY }), review(runId, "items[1].match", "NO_MATCH")])),
    );
    assert.equal(row(crossedOnly, "quantity", CUTLERY).outcome, "DIFFERENCE");
    assert.equal(row(crossedOnly, "quantity", CUTLERY).quote[0].used, "300");
    assert.equal(crossedOnly.rows.find((r) => r.note.code === "EXTRA_QUOTE_ITEM")?.quoteItemIndex, 1);
  });

  test("ambiguous, unmatched, unknown ids and a missing line stay open — nothing is matched by position", () => {
    const c = compareExtraction(
      stored("LA-3", (i) => {
        const r = i.run.result as ExtractionResult;
        r.items[0].match = { status: "AMBIGUOUS", candidateIds: [LUNCH, CUTLERY], rejectedIds: [] };
        r.items[1].match = { status: "UNMATCHED", candidateIds: [], rejectedIds: ["pri_ffffffff-ffff-4fff-8fff-ffffffffffff"] };
        snapItems(i).push({ id: "pri_cccccccc-cccc-4ccc-8ccc-cccccccccccc", position: 3, name: "Bamboo straw", quantity: 100, unit: "pcs", material: null, specification: null, customization: null, notes: null });
      }),
    );
    assert.deepEqual(
      c.pairings.map((p) => p.status),
      ["NEEDS_CHOICE", "NEEDS_CHOICE"],
    );
    assert.equal(rows(c, "quantity").length, 0);
    assert.equal(rows(c, "pairing").filter((r) => r.note.code === "PAIRING_NEEDS_CHOICE").length, 2);
    assert.equal(rows(c, "pairing").filter((r) => r.note.code === "NOT_QUOTED").length, 3);
    assert.equal(c.summary.pairsOpen, 2);

    const forged = compareExtraction(stored("LA-3", (i) => (i.reviews = [review(LA3.run.id, "items[0].match", "MATCH_ITEM", { requestItemId: "pri_ffffffff-ffff-4fff-8fff-ffffffffffff" })])));
    assert.equal(forged.pairings[0].status, "NEEDS_CHOICE");
    assert.equal(forged.pairings[0].invalidChoice, "pri_ffffffff-ffff-4fff-8fff-ffffffffffff");
  });
});

// ---------------------------------------------------------------- C3 corrections and reviews

describe("C3 — user corrections are used; model value, excerpt and check stay unchanged", () => {
  const LA1 = STORED.cases["LA-1"];
  const runId = LA1.run.id;

  test("a corrected quantity is used and labelled as the user's statement; the stored result is not touched", () => {
    const input = stored("LA-1", (i) => (i.reviews = [review(runId, "items[0].quantity", "CORRECT", { valueText: "250" })]));
    const before = JSON.stringify(input.run.result);
    const q = row(compareExtraction(input), "quantity");
    assert.equal(q.outcome, "DIFFERENCE");
    assert.deepEqual([q.quote[0].used, q.quote[0].usedFrom, q.quote[0].review, q.quote[0].correctionText], ["250", "USER_CORRECTED", "CORRECTED", "250"]);
    assert.equal(q.quote[0].modelValue, "200");
    assert.equal(q.quote[0].check, "SUPPORTED");
    assert.equal(q.quote[0].evidence?.excerpt, LA1.run.result!.items[0].quantity.evidence?.excerpt);
    assert.equal(JSON.stringify(input.run.result), before);
  });

  test("a correction that is not a valid value is not used; latest review wins; reviews of other runs never apply", () => {
    const bad = row(compareExtraction(stored("LA-1", (i) => (i.reviews = [review(runId, "items[0].quantity", "CORRECT", { valueText: "about 250" })]))), "quantity");
    assert.equal(bad.outcome, "OPEN");
    assert.equal(bad.note.code, "CORRECTION_UNREADABLE");
    assert.equal(bad.quote[0].used, null);

    const chain = (actions: ExtractionReview[]) => row(compareExtraction(stored("LA-1", (i) => (i.reviews = actions))), "quantity").quote[0];
    assert.equal(chain([review(runId, "items[0].quantity", "CONFIRM"), review(runId, "items[0].quantity", "CORRECT", { valueText: "210" })]).used, "210");
    assert.equal(chain([review(runId, "items[0].quantity", "CORRECT", { valueText: "210" }), review(runId, "items[0].quantity", "REJECT")]).review, "REJECTED");
    const confirmed = chain([review(runId, "items[0].quantity", "CONFIRM")]);
    assert.deepEqual([confirmed.used, confirmed.usedFrom, confirmed.review], ["200", "USER_CONFIRMED", "CONFIRMED"]);

    // A review stored for another run (same field path) is ignored even if passed in.
    const other = chain([review(STORED.cases["LA-3"].run.id, "items[0].quantity", "CORRECT", { valueText: "999" })]);
    assert.deepEqual([other.used, other.review], ["200", "PENDING"]);
  });

  test("money and currency corrections need a named currency (LA-5's bare $ is never read as USD)", () => {
    const la5 = STORED.cases["LA-5"].run.id;
    assert.deepEqual(readMoney("USD 2.80"), { currency: "USD", minor: BigInt(280) });
    assert.deepEqual(readMoney("1,120.00 usd"), { currency: "USD", minor: BigInt(112000) });
    assert.equal(readMoney("$2.80"), null);
    assert.equal(readMoney("2.80"), null);
    assert.equal(readMoney("USD 1.800,00"), null);
    const c = compareExtraction(
      stored("LA-5", (i) => (i.reviews = [review(la5, "items[0].unitPrice", "CORRECT", { valueText: "USD 2.80" }), review(la5, "currency", "CORRECT", { valueText: "USD" })])),
    );
    assert.equal(c.pairings[0].unitPrice.used, "USD 2.80");
    assert.equal(c.pairings[0].lineSubtotal, "USD 1,120.00"); // 400 × 2.80, exact
    assert.equal(rows(c, "unitPrice").length, 0);
    const bare = compareExtraction(stored("LA-5", (i) => (i.reviews = [review(la5, "items[0].unitPrice", "CORRECT", { valueText: "2.80" })])));
    assert.equal(row(bare, "unitPrice").note.code, "CORRECTION_UNREADABLE");
  });
});

// ---------------------------------------------------------------- C4 wording

describe("C4 — passing the value checks is never shown as verified or agreed", () => {
  test("LA-1 (all values passed the checks): consistent rows still say 'source excerpt found — review required'", () => {
    const c = compareExtraction(stored("LA-1"));
    const matches = c.rows.filter((r) => r.outcome === "MATCH");
    assert.ok(matches.length >= 3);
    for (const r of matches) for (const q of r.quote) assert.deepEqual([q.usedFrom, q.review], ["MODEL", "PENDING"]);
    assert.match(en.comparison.value.model, /source excerpt found, review required/i);
    assert.equal(en.comparison.outcomes.MATCH, "Consistent");
    assert.equal(c.summary.pending, c.summary.valuesUsed);
    assert.equal(userConfirmedMatches(c).length, 0);
  });

  test("no comparison string claims verification, agreement or approval (only negated)", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "function") strings.push(String((v as (...a: unknown[]) => unknown)({ text: "x", rule: "FOB", quoted: "a", wanted: "b", total: "t", budget: "b", sum: "s", days: "1", depositBy: "d", shipBy: "s", asOf: "a", candidates: "1", list: "l", field: "f", item: "i", fee: "f" }, 1, 1, 1, 1)));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(en.comparison);
    for (const s of strings) {
      for (const m of s.matchAll(/\b(verified|agreed|approved|accepted|confirmed)\b/gi)) {
        const before = s.slice(Math.max(0, m.index! - 40), m.index!).toLowerCase();
        // Allowed: negated ("not verified"), attributed to the user ("Your review … confirmed", "confirmed by you"), or quoting "to be agreed".
        const ok = /\b(not|never|no|nothing|not yet)\b/.test(before) || /\byour?\b/i.test(s) || /“to be agreed”/.test(s);
        assert.ok(ok, `"${s}" uses "${m[0]}" without a negation or a user attribution`);
      }
    }
  });
});

// ---------------------------------------------------------------- C5 open costs and conditions

describe("C5 — unknown fee scope, unknown currency, repeated goods lines, unsettled terms stay open", () => {
  test("LA-3: per-unit packaging 'for Item A only' is not allocated; the GOODS line equal to the total is not added", () => {
    const c = compareExtraction(stored("LA-3"));
    const [goods, packaging] = c.fees;
    assert.deepEqual([goods.status, goods.reasons], ["SUSPECTED_DUPLICATE", ["GOODS_EQUALS_TOTAL"]]);
    assert.equal(goods.amount.used, "USD 2,370.00"); // original output kept
    assert.deepEqual([packaging.status, packaging.reasons], ["OPEN", ["PER_UNIT_NOT_ALLOCATED"]]);
    assert.equal(packaging.amount.used, "USD 0.30");
    assert.deepEqual(c.cost.lines, [{ currency: "USD", statedGoodsTotal: "2,370.00", sumOfItemLines: "2,370.00", knownExtras: "0.00", knownExtraCount: 0 }]);
    assert.equal(c.cost.complete, false);
    assert.equal(c.cost.paymentAmount, null);
    assert.equal(c.cost.openCount, 1);
    assert.equal(c.cost.duplicateCount, 1);
    assert.ok(c.questions.some((q) => q.code === "CLARIFY_FEE" && q.args.fee.includes("Item A only")));
  });

  test("LA-5: no currency is assumed, unknown amounts are not 0, 'to be agreed after sample approval' is open", () => {
    const c = compareExtraction(stored("LA-5"));
    assert.equal(row(c, "currency").outcome, "OPEN");
    assert.equal(row(c, "unitPrice").outcome, "OPEN");
    assert.equal(row(c, "unitPrice").quote[0].used, null);
    assert.equal(row(c, "arithmetic").note.code, "CANNOT_CHECK_TOTAL");
    const pt = row(c, "paymentTerms");
    assert.deepEqual([pt.outcome, pt.note.code], ["OPEN", "NOT_AGREED"]);
    assert.equal(pt.quote[0].check, "SUPPORTED"); // the excerpt was found — still not a term
    assert.deepEqual(
      c.fees.map((f) => [f.status, f.reasons]),
      [
        ["SUSPECTED_DUPLICATE", ["GOODS_REPEAT"]],
        ["OPEN", ["AMOUNT_NOT_STATED", "INCLUSION_UNKNOWN", "NOT_FIRM"]],
        ["OPEN", ["AMOUNT_NOT_STATED", "NOT_FIRM"]],
      ],
    );
    assert.deepEqual(c.cost.lines, []); // nothing with a known currency → no subtotal, never "USD"
    assert.ok(!JSON.stringify(c.cost).includes("USD"));
    assert.ok(c.questions.some((q) => q.code === "STATE_AGREED_TERM"));
  });

  test("LA-1: the repeated GOODS line and freight 'not included' without amount are open; no total cost", () => {
    const c = compareExtraction(stored("LA-1"));
    assert.deepEqual(
      c.fees.map((f) => [f.status, f.reasons]),
      [
        ["SUSPECTED_DUPLICATE", ["GOODS_EQUALS_TOTAL"]],
        ["OPEN", ["AMOUNT_NOT_STATED", "NOT_FIRM"]],
      ],
    );
    assert.equal(c.summary.open, c.rows.filter((r) => r.outcome === "OPEN").length + 2);
  });

  test("known lump-sum extras are added per currency only, never across currencies; per-unit and unknown ones never", () => {
    const c = compareExtraction(
      stored("LA-1", (i) => {
        const r = i.run.result as ExtractionResult;
        const freight = r.fees[1];
        const lump = (amountText: string, currency: "USD" | "SGD", minor: number) => {
          const f = clone(freight);
          f.amount = { ...f.amount, value: { amountText, currency, minor }, check: "SUPPORTED", modelValue: `${currency} ${amountText}` };
          f.amountBasis = { ...f.amountBasis, value: "LUMP_SUM", check: "SUPPORTED", modelValue: "LUMP_SUM" };
          f.statedAs = { ...f.statedAs, value: "FIRM", check: "SUPPORTED", modelValue: "FIRM" };
          f.kind = { ...f.kind, value: "OTHER", modelValue: "OTHER" };
          return f;
        };
        r.fees.push(lump("50.00", "USD", 5000), lump("0.10", "USD", 10), lump("12.00", "SGD", 1200));
      }),
    );
    assert.deepEqual(
      c.cost.lines.map((l) => [l.currency, l.knownExtras, l.knownExtraCount]),
      [
        ["USD", "50.10", 2],
        ["SGD", "12.00", 1],
      ],
    );
    assert.equal(c.cost.lines[0].statedGoodsTotal, "820.00"); // the GOODS repeat is not added on top
  });

  test("the not-agreed hint is only a hint: unparsed wording is open even without any listed phrase", () => {
    assert.ok(looksNotAgreed("to be agreed after sample approval"));
    assert.ok(looksNotAgreed("交期待定"));
    assert.ok(!looksNotAgreed("30% deposit, 70% before shipment"));
    const c = compareExtraction(
      stored("LA-1", (i) => {
        record(i).paymentTerms = "30% deposit, balance before shipment";
        const r = i.run.result as ExtractionResult;
        r.paymentTerms = { ...r.paymentTerms, value: "payment as usual" };
      }),
    );
    assert.deepEqual([row(c, "paymentTerms").outcome, row(c, "paymentTerms").note.code], ["OPEN", "QUOTE_WORDING_NOT_RECOGNISED"]);
  });

  test("request-level checks: budget cap (exact integer), currency never converted, lead time vs ship date", () => {
    const c = compareExtraction(
      stored("LA-1", (i) => {
        Object.assign(record(i), { budgetCurrency: "USD", budgetMaxMinor: 81999, budgetMax: "819.99", requiredShipDate: "2026-11-20", paymentTerms: "30% deposit, 70% before shipment" });
      }),
    );
    assert.equal(row(c, "budget").note.code, "OVER_BUDGET");
    assert.equal(row(c, "currency").outcome, "MATCH");
    assert.equal(row(c, "paymentTerms").outcome, "MATCH");
    const lt = row(c, "leadTime"); // 30 days after deposit, ship by 20 Nov → deposit by 21 Oct; today 26 Oct
    assert.deepEqual([lt.outcome, lt.note.args.depositBy], ["DIFFERENCE", "2026-10-21"]);
    const equal = compareExtraction(stored("LA-1", (i) => Object.assign(record(i), { budgetCurrency: "USD", budgetMaxMinor: 82000, budgetMax: "820.00", requiredShipDate: "2026-11-25" })));
    assert.equal(row(equal, "budget").note.code, "WITHIN_BUDGET");
    assert.equal(row(equal, "leadTime").outcome, "MATCH");
    const sgd = compareExtraction(stored("LA-1", (i) => Object.assign(record(i), { budgetCurrency: "SGD", budgetMaxMinor: 100000, budgetMax: "1000.00" })));
    assert.equal(row(sgd, "currency").note.code, "CURRENCY_DIFFERS");
    assert.equal(row(sgd, "budget").note.code, "BUDGET_OTHER_CURRENCY");
  });
});

// ---------------------------------------------------------------- supplements

describe("supplements use the explicitly linked base version", () => {
  const LA4 = STORED.cases["LA-4"];

  test("LA-4 (supplement → v1, no run of v1): only the lead time is stated; everything else is unresolved, nothing from v2", () => {
    const c = compareExtraction(stored("LA-4"));
    assert.equal(c.binding.base?.versionId, LA4.base!.id);
    assert.equal(c.binding.base?.versionNumber, 1);
    assert.equal(c.binding.base?.run, null);
    assert.deepEqual(
      c.inheritance.map((e) => [e.field, e.status]),
      [
        ["currency", "UNRESOLVED"],
        ["total", "UNRESOLVED"],
        ["incoterm", "UNRESOLVED"],
        ["leadTime", "STATED_IN_SUPPLEMENT"],
        ["paymentTerms", "UNRESOLVED"],
      ],
    );
    assert.equal(c.inheritance.find((e) => e.field === "leadTime")!.views[0].used, "35 days after deposit");
    assert.ok(c.unresolvedInheritance.includes(`item:${LA4.version.snapshot.record.items[0].id}`));
    assert.equal(c.summary.open, 5); // the unresolved request line (a row) + 4 unresolved inherited terms
    assert.equal(c.cost.computed, false);
    assert.ok(!JSON.stringify(c).includes("LA-004-R2") && !JSON.stringify(c).includes("850.00")); // v2 values never appear
  });

  test("with a run of the linked v1: changed terms show both values, unchanged terms are inherited and labelled", () => {
    const v1Text = LA4.base!.rawText;
    const T = (value: string, quote = value) => ({ value, quote });
    const line = LA4.base!.snapshot.record.items[0].id;
    const output: ModelOutput = {
      supplierQuoteNumbers: [T("LA-004", "Quotation No.: LA-004")],
      quoteDate: T("2026-10-15", "Date: 2026-10-15"),
      currency: T("USD", "Total: USD 900.00"),
      items: [
        {
          name: T("Cotton tote bag, 38 x 42 cm, natural colour"),
          quantity: T("1000", "1000 pcs @ USD 0.90"),
          unit: T("pcs", "1000 pcs @ USD 0.90"),
          material: { value: null, quote: null },
          specification: { value: null, quote: null },
          logo: { value: null, quote: null },
          unitPrice: { amount: "0.90", currency: "USD", quote: "1000 pcs @ USD 0.90" },
          requestItemCandidates: [line],
        },
      ],
      total: { amount: "900.00", currency: "USD", quote: "Total: USD 900.00" },
      incoterm: T("FOB Shanghai", "Trade term: FOB Shanghai"),
      leadTime: T("25 days after deposit", "Lead time: 25 days after deposit"),
      paymentTerms: { value: null, quote: null },
      fees: [],
    };
    const result = checkExtraction(output, { text: v1Text, contextText: null, contentKind: "FULL_QUOTE", snapshotItemIds: new Set([line]) });
    const baseRun: ExtractionRun = { ...clone(LA4.run), id: "qx_00000000-0000-4000-8000-0000000000b1", versionId: LA4.base!.id, inputSha256: LA4.base!.rawTextSha256, contextVersionId: null, requestRevision: LA4.base!.requestRevision, result };
    assert.equal(runRefusal(baseRun, facts(LA4.base!)), null);
    const c = compareExtraction(stored("LA-4", (i) => (i.base = { version: facts(LA4.base!), run: baseRun, reviews: [] })));
    const lead = c.inheritance.find((e) => e.field === "leadTime")!;
    assert.equal(lead.status, "CHANGED_BY_SUPPLEMENT");
    assert.deepEqual(
      lead.views.map((v) => [v.source, v.used]),
      [
        ["THIS_VERSION", "35 days after deposit"],
        ["BASE_VERSION", "25 days after deposit"],
      ],
    );
    assert.deepEqual(
      c.inheritance.filter((e) => e.status === "INHERITED").map((e) => [e.field, e.views[0].used, e.views[0].versionNumber]),
      [
        ["currency", "USD", 1],
        ["total", "USD 900.00", 1],
        ["incoterm", "FOB Shanghai", 1],
        ["paymentTerms", null, 1], // v1 does not state it either: inherited as "not stated", never invented
      ],
    );
    assert.equal(row(c, "quantity").quote[0].source, "BASE_VERSION");
    assert.deepEqual(c.unresolvedInheritance, []);
  });
});

// ---------------------------------------------------------------- C6 never approval or payment

describe("C6 — unconfirmed results only give differences and questions", () => {
  test("no approved term or payment amount comes out; only user-confirmed matching rows are offered to the later approval step", () => {
    const LA1 = STORED.cases["LA-1"];
    const line = LA1.version.snapshot.record.items[0].id;
    const pending = compareExtraction(stored("LA-1"));
    assert.equal(pending.use, "DISCREPANCIES_AND_QUESTIONS_ONLY");
    assert.equal(pending.cost.paymentAmount, null);
    assert.equal(userConfirmedMatches(pending).length, 0);
    const json = JSON.stringify(pending);
    assert.ok(!/approved|payable|amountToPay|payee/i.test(json));

    const partly = compareExtraction(
      stored("LA-1", (i) => (i.reviews = [review(LA1.run.id, "items[0].quantity", "CONFIRM"), review(LA1.run.id, "items[0].match", "MATCH_ITEM", { requestItemId: line })])),
    );
    assert.deepEqual(
      userConfirmedMatches(partly).map((r) => r.field),
      ["quantity"],
    );
    // A confirmed value on a pairing the user has not chosen is still not offered.
    const unpaired = compareExtraction(stored("LA-1", (i) => (i.reviews = [review(LA1.run.id, "items[0].quantity", "CONFIRM")])));
    assert.equal(userConfirmedMatches(unpaired).length, 0);
  });
});

// ---------------------------------------------------------------- service, store and HTTP (temp DBs)

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-comparison-test-"));
});
after(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const P = testBuyer();

function normalized(body: ProcurementInput, mode: "create" | "update" = "create") {
  const r = validateProcurementInput(body, mode);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return r.value;
}

/**
 * Replays a STORED raw model output through the normal extraction path (parse → server checks), with the
 * stored snapshot line ids mapped by name to this test request's line ids. Counts calls. MOCK mode, so it
 * never touches the API budget. It is a test double, not a model.
 */
function replay(): ExtractionModel & { calls: number; next: { raw: string; ids: Record<string, string> } | null } {
  const m = {
    mode: "MOCK" as const,
    provider: "test-replay",
    model: "stored-output",
    calls: 0,
    next: null as { raw: string; ids: Record<string, string> } | null,
    async complete(): Promise<ModelReply> {
      m.calls += 1;
      let text = m.next!.raw;
      for (const [from, to] of Object.entries(m.next!.ids)) text = text.split(from).join(to);
      return { text, truncated: false, inputTokens: null, outputTokens: null };
    },
  };
  return m;
}

function world() {
  const path = join(dir, `cmp-${++counter}.sqlite`);
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const bs = new BudgetStore(path);
  open.push(ps, qs, es, bs);
  const model = replay();
  const resolveModel = (): ResolvedModel => ({ config: { state: "READY", mode: "MOCK", provider: model.provider, model: model.model }, model }) as ResolvedModel;
  const svc = new ExtractionService(es, { resolveModel, nonce: () => "n", limits: { timeoutMs: 500, maxAttempts: 1, retryDelayMs: 1 }, budget: bs, resolveBudget: generousBudget() });
  const cmp = new ComparisonService(es, { now: () => new Date("2026-10-26T02:00:00Z") });
  return { path, ps, qs, es, bs, model, svc, cmp };
}

type World = ReturnType<typeof world>;

/** A [TEST] request rebuilt from a stored snapshot (same names and quantities; new line ids). */
function requestFrom(w: World, key: string) {
  const snap = STORED.cases[key].version.snapshot.record;
  const input: ProcurementInput = {
    ...emptyInput(),
    buyerType: "BUSINESS",
    buyerCompany: "Test Co",
    title: `[TEST] comparator — ${key}`,
    items: snap.items.map((i) => ({ id: null, name: i.name, quantity: i.quantity === null ? "" : String(i.quantity), unit: i.unit ?? "", material: i.material ?? "", specification: i.specification ?? "", customization: i.customization ?? "", notes: "" })),
  };
  const rec = w.ps.create(normalized(input), "USER_INPUT");
  const ids = Object.fromEntries(snap.items.map((old) => [old.id, rec.items.find((n) => n.name === old.name)!.id]));
  return { rec, ids, input };
}

async function extract(w: World, requestId: string, seriesId: string, versionId: string, key: string, ids: Record<string, string>) {
  w.model.next = { raw: STORED.cases[key].run.rawOutput!, ids };
  const o = await w.svc.run(P, requestId, seriesId, versionId, { idempotencyKey: randomUUID(), rerun: true });
  assert.equal(o.status, "FINISHED");
  return (o as { run: ExtractionRun }).run;
}

function saveSeries(w: World, requestId: string, revision: number, key: string, text = STORED.cases[key].version.rawText) {
  const saved = w.qs.createSeries(requestId, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: revision,
    name: `[TEST] ${key}`,
    supplierDisplayName: null,
    version: { rawText: text, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "stored-runs.synthetic.json", supplierQuoteDate: null, revisionNote: null },
  });
  assert.ok(saved.status === "CREATED");
  return saved;
}

const counts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return { runs: n("SELECT count(*) AS n FROM quote_extraction_runs"), reviews: n("SELECT count(*) AS n FROM quote_extraction_reviews"), ledger: n("SELECT count(*) AS n FROM ai_budget_ledger"), versions: n("SELECT count(*) AS n FROM quote_versions") };
  } finally {
    db.close();
  }
};

describe("service: stored records only, ownership enforced, nothing written", () => {
  test("replayed LA-3 output in a temp DB compares like the stored run; cross-record and cross-version runs are refused", async () => {
    const w = world();
    const { rec, ids } = requestFrom(w, "LA-3");
    const saved = saveSeries(w, rec.id, 1, "LA-3");
    const r1 = await extract(w, rec.id, saved.series.id, saved.version.id, "LA-3", ids);
    assert.equal(r1.status, "SUCCEEDED");
    const ok = w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, r1.id, null);
    assert.equal(ok.status, "OK");
    const c = (ok as { comparison: Comparison }).comparison;
    assert.deepEqual(
      rows(c, "quantity").map((r) => [r.requestText, r.quote[0].used, r.outcome]),
      [
        ["300 sets", "300", "MATCH"],
        ["600 sets", "600", "MATCH"],
      ],
    );
    assert.deepEqual(
      c.fees.map((f) => f.status),
      ["SUSPECTED_DUPLICATE", "OPEN"],
    );

    // Same request, second version: its run cannot be used for v1 (and vice versa).
    const v2 = w.qs.addVersion(rec.id, saved.series.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      expectedLatestVersionId: saved.version.id,
      version: { rawText: STORED.cases["LA-3"].version.rawText + "\nRevised.", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(v2.status === "CREATED");
    const r2 = await extract(w, rec.id, saved.series.id, v2.version.id, "LA-3", ids);
    assert.deepEqual(w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, r2.id, null).status === "REFUSED" && (w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, r2.id, null) as { code: string }).code, "RUN_NOT_FOR_VERSION");

    // A run of another request is not this request's data: NOT_FOUND (no detail).
    const other = requestFrom(w, "LA-1");
    const os = saveSeries(w, other.rec.id, 1, "LA-1");
    const ro = await extract(w, other.rec.id, os.series.id, os.version.id, "LA-1", other.ids);
    assert.equal(w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, ro.id, null).status, "NOT_FOUND");
    // Version of another request named under this request: NOT_FOUND.
    assert.equal(w.cmp.compare(P, rec.id, saved.series.id, os.version.id, ro.id, null).status, "NOT_FOUND");
    // No run named → only the choices; the stored run is listed as usable.
    const choose = w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, null, null);
    assert.ok(choose.status === "CHOOSE" && choose.choices.runs.every((r) => r.refusal === null));
  });

  test("older-rules run is listed but refused; updating the request keeps the saved snapshot as basis", async () => {
    const w = world();
    const { rec, ids, input } = requestFrom(w, "LA-1");
    const saved = saveSeries(w, rec.id, 1, "LA-1");
    const run = await extract(w, rec.id, saved.series.id, saved.version.id, "LA-1", ids);
    // An older run (no checkRules = substring rules) inserted as it would have been stored on 24 Oct.
    const legacy = clone(run.result!) as Partial<ExtractionResult>;
    delete legacy.checkRules;
    const raw = new DatabaseSync(w.path);
    raw.prepare(
      `INSERT INTO quote_extraction_runs (id, request_id, series_id, version_id, input_sha256, request_revision, context_version_id, mode, provider, model, prompt_version, schema_version, idempotency_key, status, attempts, started_at, finished_at, result_json)
       SELECT 'qx_00000000-0000-4000-8000-00000000eeee', request_id, series_id, version_id, input_sha256, request_revision, NULL, mode, provider, model, prompt_version, 'extraction-result-1', 'legacy-key', 'SUCCEEDED', 1, '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:01.000Z', ? FROM quote_extraction_runs WHERE id = ?`,
    ).run(JSON.stringify(legacy), run.id);
    raw.close();
    const refused = w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, "qx_00000000-0000-4000-8000-00000000eeee", null);
    assert.ok(refused.status === "REFUSED" && refused.code === "LEGACY_RULES");
    assert.equal(refused.choices.runs.find((r) => r.id === "qx_00000000-0000-4000-8000-00000000eeee")?.refusal, "LEGACY_RULES");

    const changed = { ...input, items: input.items.map((i, n) => ({ ...i, id: rec.items[n].id, quantity: "999" })) };
    const upd = w.ps.update(rec.id, 1, normalized(changed, "update"));
    assert.equal(upd.status, "UPDATED");
    const after = w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, run.id, null);
    assert.ok(after.status === "OK");
    assert.equal(after.comparison.binding.requestUpdated, true);
    assert.equal(after.comparison.binding.currentRequestRevision, 2);
    assert.equal(after.comparison.binding.snapshotRevision, 1);
    assert.equal(row(after.comparison, "quantity").requestText, "200 pcs");
    assert.equal(row(after.comparison, "quantity").outcome, "MATCH");
  });

  test("supplement: v3 → v1 explicitly; a run of v2 (latest full quote) is refused as base; reviews never cross runs", async () => {
    const w = world();
    const { rec, ids } = requestFrom(w, "LA-4");
    const LA4 = STORED.cases["LA-4"];
    const s1 = saveSeries(w, rec.id, 1, "LA-4", LA4.base!.rawText);
    const v2 = w.qs.addVersion(rec.id, s1.series.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      expectedLatestVersionId: s1.version.id,
      version: { rawText: readFileSync(join("samples", "synthetic", "live-acceptance", "la-4-v2.synthetic.md"), "utf8").replace(/\r\n/g, "\n"), contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(v2.status === "CREATED");
    const v3 = w.qs.addVersion(rec.id, s1.series.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      expectedLatestVersionId: v2.version.id,
      version: { rawText: LA4.version.rawText, contentKind: "SUPPLEMENT", supplementsVersionId: s1.version.id, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(v3.status === "CREATED");
    const sup = await extract(w, rec.id, s1.series.id, v3.version.id, "LA-4", ids);
    assert.equal(sup.contextVersionId, s1.version.id);
    // A v2 run (replaying LA-1's shape is irrelevant here: only ownership is tested) — use the supplement output on v2.
    const r2 = await extract(w, rec.id, s1.series.id, v2.version.id, "LA-4", ids);

    const noBase = w.cmp.compare(P, rec.id, s1.series.id, v3.version.id, sup.id, null);
    assert.ok(noBase.status === "OK");
    assert.equal(noBase.choices.base?.versionNumber, 1);
    assert.equal(noBase.comparison.binding.base?.versionNumber, 1);
    assert.ok(noBase.comparison.unresolvedInheritance.includes("total"));
    const wrong = w.cmp.compare(P, rec.id, s1.series.id, v3.version.id, sup.id, r2.id);
    assert.ok(wrong.status === "REFUSED" && wrong.code === "BASE_RUN_NOT_FOR_BASE_VERSION");
    // A base run for a full quote makes no sense.
    const na = w.cmp.compare(P, rec.id, s1.series.id, v2.version.id, r2.id, sup.id);
    assert.ok(na.status === "REFUSED" && na.code === "BASE_RUN_NOT_APPLICABLE");
  });

  test("a review saved on one run changes only that run's comparison", async () => {
    const w = world();
    const { rec, ids } = requestFrom(w, "LA-1");
    const saved = saveSeries(w, rec.id, 1, "LA-1");
    const a = await extract(w, rec.id, saved.series.id, saved.version.id, "LA-1", ids);
    const b = await extract(w, rec.id, saved.series.id, saved.version.id, "LA-1", ids);
    const saveReview = w.svc.review(P, rec.id, saved.series.id, saved.version.id, a.id, { idempotencyKey: randomUUID(), fieldPath: "items[0].quantity", action: "CORRECT", valueText: "180", requestItemId: null, basedOnReviewId: null });
    assert.equal(saveReview.status, "CREATED");
    const ca = w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, a.id, null);
    const cb = w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, b.id, null);
    assert.ok(ca.status === "OK" && cb.status === "OK");
    assert.deepEqual([row(ca.comparison, "quantity").quote[0].used, row(ca.comparison, "quantity").outcome], ["180", "DIFFERENCE"]);
    assert.deepEqual([row(cb.comparison, "quantity").quote[0].used, row(cb.comparison, "quantity").quote[0].review], ["200", "PENDING"]);
    // The stored result of run a is unchanged (the correction lives only in the review row).
    assert.equal(w.es.getRun(a.id)!.result!.items[0].quantity.value, 200);
  });
});

describe("C7 — comparing never calls a model and writes nothing", () => {
  test("model call counter, runs, reviews, versions and budget ledger unchanged by any number of comparisons", async () => {
    const w = world();
    const { rec, ids } = requestFrom(w, "LA-5");
    const saved = saveSeries(w, rec.id, 1, "LA-5");
    const run = await extract(w, rec.id, saved.series.id, saved.version.id, "LA-5", ids);
    const callsBefore = w.model.calls;
    const before = counts(w.path);
    for (let i = 0; i < 5; i++) {
      w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, run.id, null);
      w.cmp.compare(P, rec.id, saved.series.id, saved.version.id, null, null);
      await handleComparison(new Request(`http://127.0.0.1:3000/api/x?run=${run.id}`, { headers: { host: "127.0.0.1:3000" } }), rec.id, saved.series.id, saved.version.id, w.cmp, { enabled: true, auth: testGate() });
    }
    assert.equal(w.model.calls, callsBefore);
    assert.deepEqual(counts(w.path), before);
    assert.equal(before.ledger, 0);
  });

  test("the comparison code imports no model, adapter or extraction-run entry point", () => {
    for (const file of ["src/lib/comparison.ts", "src/server/comparison/service.ts", "src/server/comparison/http.ts", "src/server/comparison/index.ts", "src/app/procurements/[id]/quotes/compare/page.tsx", "src/app/api/procurements/[id]/quotes/[seriesId]/versions/[versionId]/comparison/route.ts"]) {
      const src = readFileSync(file, "utf8");
      assert.ok(!/extraction\/model|anthropic|callModel|\.run\(|budget\/store|method:\s*"POST"|export async function POST/.test(src), `${file} must not reach a model or start a run`);
    }
  });
});

describe("HTTP", () => {
  test("GET only; ids validated; unknown parameters refused; refusals are 409 with the reason", async () => {
    const w = world();
    const { rec, ids } = requestFrom(w, "LA-1");
    const saved = saveSeries(w, rec.id, 1, "LA-1");
    const run = await extract(w, rec.id, saved.series.id, saved.version.id, "LA-1", ids);
    const get = (query: string, host = "127.0.0.1:3000") => handleComparison(new Request(`http://127.0.0.1:3000/api/c${query}`, { headers: { host } }), rec.id, saved.series.id, saved.version.id, w.cmp, { enabled: true, auth: testGate() });
    const choose = await get("");
    assert.equal(choose.status, 200);
    assert.ok(((await choose.json()) as { choices: { runs: unknown[] } }).choices.runs.length === 1);
    const ok = await get(`?run=${run.id}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { comparison: Comparison };
    assert.equal(body.comparison.binding.run.id, run.id);
    assert.equal((await get(`?run=${run.id}&rawText=hello`)).status, 422);
    assert.equal((await get(`?run=not-a-run`)).status, 422);
    assert.equal((await get(`?baseRun=${run.id}`)).status, 422);
    assert.equal((await get(`?run=qx_00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await get(`?run=${run.id}`, "evil.example")).status, 403); // existing loopback guard
    const route = readFileSync("src/app/api/procurements/[id]/quotes/[seriesId]/versions/[versionId]/comparison/route.ts", "utf8");
    assert.ok(route.includes("export async function GET") && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
  });

  test("Singapore day for the lead-time check", () => {
    assert.equal(singaporeDay(new Date("2026-10-25T15:59:59Z")), "2026-10-25");
    assert.equal(singaporeDay(new Date("2026-10-25T16:00:00Z")), "2026-10-26");
  });
});
