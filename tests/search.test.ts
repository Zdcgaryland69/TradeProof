// Search over requests and quotes (design §3, acceptance A3 / A4). Temporary databases only.
// Supplier numbers are created through the real paths: a MOCK-mode fake run proposes AI candidates;
// the user's CONFIRM / CORRECT reviews write user-side values. No model is called by search.
// Run: npm test

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import type { ExtractionRun } from "../src/lib/extraction.ts";
import { emptyInput, shortProcurementId } from "../src/lib/procurement.ts";
import { looseKey, searchKey, validateSearchQuery, type SearchHit } from "../src/lib/search.ts";
import type { Principal } from "../src/server/access/policy.ts";
import type { ExtractionModel, ModelReply, ModelRequest, ResolvedModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { handleSearch } from "../src/server/search/http.ts";
import { SearchStore } from "../src/server/search/store.ts";
import { testBuyer, testGate, ALL_REQUESTS } from "./helpers/principals.ts";

let dir: string;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-search-"));
});
after(() => {
  for (const s of open) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const P: Principal = testBuyer();

/** MOCK-mode fake: proposes the number after "Quotation No." with that line as the excerpt. */
const numberModel: ExtractionModel & { calls: number } = {
  mode: "MOCK",
  provider: "fake",
  model: "number-finder",
  calls: 0,
  async complete(req: ModelRequest): Promise<ModelReply> {
    numberModel.calls++;
    const m = /Quotation No\. (\S+)/.exec(req.mockInput!.text);
    const out = { supplierQuoteNumbers: m ? [{ value: m[1], quote: m[0] }] : [], quoteDate: null, currency: null, items: [], total: null, incoterm: null, leadTime: null, paymentTerms: null, fees: [] };
    return { text: JSON.stringify(out), truncated: false, inputTokens: null, outputTokens: null };
  },
};

function world() {
  const path = join(dir, `s-${randomUUID().slice(0, 8)}.sqlite`);
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const ss = new SearchStore(path);
  open.push(ps, qs, es, ss);
  const svc = new ExtractionService(es, { resolveModel: () => ({ config: { state: "READY", mode: "MOCK", provider: "fake", model: "number-finder" }, model: numberModel }) as ResolvedModel, nonce: () => "n" });
  const request = (title: string) => {
    const r = validateProcurementInput({ ...emptyInput(), buyerType: "BUSINESS", buyerCompany: "Co", title, items: [{ id: null, name: "Bag", quantity: "10", unit: "", material: "", specification: "", customization: "", notes: "" }] }, "create");
    assert.ok(r.ok);
    return ps.create(r.value, "USER_INPUT");
  };
  const v = (rawText: string) => ({ rawText, contentKind: "FULL_QUOTE" as const, supplementsVersionId: null, source: "TEST_FIXTURE" as const, sourceNote: null, supplierQuoteDate: null, revisionNote: null });
  const series = (requestId: string, name: string, supplier: string | null, text: string) => {
    const o = qs.createSeries(requestId, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, name, supplierDisplayName: supplier, version: v(text) });
    assert.ok(o.status === "CREATED");
    return { seriesId: o.series.id, versionId: o.version.id };
  };
  const addVersion = (requestId: string, seriesId: string, latest: string, text: string) => {
    const o = qs.addVersion(requestId, seriesId, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: latest, version: v(text) });
    assert.ok(o.status === "CREATED");
    return o.version.id;
  };
  const extract = async (requestId: string, seriesId: string, versionId: string, rerun = false): Promise<ExtractionRun> => {
    const o = await svc.run(P, requestId, seriesId, versionId, { idempotencyKey: randomUUID(), rerun });
    assert.equal(o.status, "FINISHED");
    return (o as { run: ExtractionRun }).run;
  };
  const review = (requestId: string, seriesId: string, versionId: string, runId: string, action: "CONFIRM" | "CORRECT", valueText: string | null, basedOnReviewId: string | null) => {
    const o = svc.review(P, requestId, seriesId, versionId, runId, { idempotencyKey: randomUUID(), fieldPath: "supplierQuoteNumbers[0]", action, valueText, requestItemId: null, basedOnReviewId });
    assert.equal(o.status, "CREATED", JSON.stringify(o));
    return (o as { review: { id: string } }).review.id;
  };
  return { path, ps, qs, es, ss, request, series, addVersion, extract, review };
}

const brief = (h: SearchHit) => [h.series?.supplierDisplayName ?? null, h.version?.versionNumber ?? null, h.matchedValue, h.tier, h.supplierRef?.origin ?? null, h.supplierRef?.status ?? null];

describe("normalisation and input", () => {
  test("search key: NFKC, lower case, whitespace collapsed; separators and leading zeros kept", () => {
    assert.equal(searchKey("  ＱＴ－２０２６／００１８  "), "qt-2026/0018");
    assert.notEqual(searchKey("QT-2026/118"), searchKey("QT-2026-118"));
    assert.equal(looseKey("QT-2026/118"), looseKey("qt 2026.118"));
    assert.equal(searchKey("Ａ  b\tC"), "a b c");
  });

  test("bounded, single-line input", () => {
    assert.equal(validateSearchQuery("x".repeat(200)).ok, true);
    assert.equal(validateSearchQuery("x".repeat(201)).ok, false);
    assert.equal(validateSearchQuery("QT\n1").ok, false);
    assert.equal(validateSearchQuery("QT\u0000").ok, false);
    assert.equal(validateSearchQuery("\uD800").ok, false);
    assert.deepEqual(validateSearchQuery("   "), { ok: true, query: "" });
  });
});

describe("supplier quote numbers in every version (A3)", () => {
  test("v1 QT-1, v2 QT-1, v3 QT-2 at Alpha; QT-1 at Beta on another request → rows kept apart, earlier versions found", async () => {
    const w = world();
    const r1 = w.request("Steel bottles");
    const a = w.series(r1.id, "Alpha quote", "Alpha Co", "Quotation No. QT-1\nTotal USD 900");
    const a2 = w.addVersion(r1.id, a.seriesId, a.versionId, "Quotation No. QT-1\nTotal USD 880");
    const a3 = w.addVersion(r1.id, a.seriesId, a2, "Quotation No. QT-2\nTotal USD 870");
    const r2 = w.request("Glass jars");
    const b = w.series(r2.id, "Beta quote", "Beta Ltd", "Quotation No. QT-1\nTotal USD 500");
    for (const [rid, sid, vid] of [[r1.id, a.seriesId, a.versionId], [r1.id, a.seriesId, a2], [r1.id, a.seriesId, a3], [r2.id, b.seriesId, b.versionId]]) await w.extract(rid, sid, vid);

    const qt1 = w.ss.search(P, "QT-1", { sort: "OLDEST" });
    assert.deepEqual(qt1.hits.map(brief), [
      ["Alpha Co", 1, "QT-1", "EXACT", "AI_CANDIDATE", "CANDIDATE"],
      ["Alpha Co", 2, "QT-1", "EXACT", "AI_CANDIDATE", "CANDIDATE"],
      ["Beta Ltd", 1, "QT-1", "EXACT", "AI_CANDIDATE", "CANDIDATE"],
    ]);
    assert.ok(qt1.hits.every((h) => h.version!.latestVersionNumber === (h.series!.supplierDisplayName === "Alpha Co" ? 3 : 1)), "the newest version number is shown, so v1 / v2 read as earlier versions");
    assert.notEqual(qt1.hits[0].request.id, qt1.hits[2].request.id, "same number at another supplier: a separate request and series, not merged");

    const qt2 = w.ss.search(P, "QT-2");
    assert.deepEqual(qt2.hits.map(brief), [["Alpha Co", 3, "QT-2", "EXACT", "AI_CANDIDATE", "CANDIDATE"]]);
    assert.equal(w.ss.search(P, "ＱＴ－２").hits.length, 1, "full-width query");
  });

  test("AI candidate, user-confirmed, user-entered and earlier values are distinguished; candidates never show as confirmed", async () => {
    const w = world();
    const r = w.request("Cotton bags");
    const s = w.series(r.id, "Gamma quote", "Gamma", "Quotation No. QT-7/A\nTotal USD 10");
    const run = await w.extract(r.id, s.seriesId, s.versionId);
    const confirm = w.review(r.id, s.seriesId, s.versionId, run.id, "CONFIRM", null, null);
    w.review(r.id, s.seriesId, s.versionId, run.id, "CORRECT", "QT-7/B", confirm);

    const hits = w.ss.search(P, "QT-7", { sort: "OLDEST" }).hits;
    assert.deepEqual(hits.map(brief), [
      ["Gamma", 1, "QT-7/A", "CONTAINS", "AI_CANDIDATE", "CANDIDATE"],
      ["Gamma", 1, "QT-7/A", "CONTAINS", "USER_CONFIRMED", "EARLIER"],
      ["Gamma", 1, "QT-7/B", "CONTAINS", "USER_ENTERED", "CURRENT"],
    ]);
    // Separators are kept: "QT-7-A" is not an exact or contains match, only a labelled "similar" one.
    const similar = w.ss.search(P, "QT-7-A").hits;
    assert.ok(similar.length > 0 && similar.every((h) => h.tier === "SIMILAR"), JSON.stringify(similar.map(brief)));
    // Raw values are returned unchanged.
    assert.ok(hits.every((h) => h.matchedValue === "QT-7/A" || h.matchedValue === "QT-7/B"));
  });
});

describe("references, names and safety (A4)", () => {
  test("full and short Request ID; TradeProof quote reference; title and quote name", () => {
    const w = world();
    const r = w.request("Insulated tumblers");
    const s = w.series(r.id, "Delta offer 2026", "Delta", "no number here");
    assert.deepEqual(w.ss.search(P, r.id).hits.map((h) => [h.matchedField, h.tier, h.request.id]), [["REQUEST_ID", "EXACT", r.id]]);
    assert.deepEqual(w.ss.search(P, r.id.toUpperCase()).hits.map((h) => h.matchedField), ["REQUEST_ID"]);
    const short = shortProcurementId(r.id);
    const byShort = w.ss.search(P, short).hits.filter((h) => h.matchedField === "REQUEST_SHORT_REF");
    assert.deepEqual(byShort.map((h) => h.request.id), [r.id]);
    assert.deepEqual(w.ss.search(P, s.seriesId).hits.map((h) => [h.matchedField, h.series?.id]), [["QUOTE_REFERENCE", s.seriesId]]);
    assert.deepEqual(w.ss.search(P, "tumbler").hits.map((h) => h.matchedField), ["REQUEST_TITLE"]);
    assert.deepEqual(w.ss.search(P, "DELTA OFFER").hits.map((h) => h.matchedField), ["QUOTE_NAME"]);
    assert.deepEqual(w.ss.search(P, "no such thing").hits, []);
  });

  test("an ambiguous short code lists every candidate and picks none; more digits narrow it; too short is refused with a note", () => {
    const w = world();
    const r = w.request("Ambiguity");
    const raw = new DatabaseSync(w.path);
    const ins = raw.prepare("INSERT INTO quote_series (id, request_id, name, supplier_display_name, created_at) VALUES (?, ?, ?, NULL, ?)");
    ins.run("qs_abcd1234-0000-4000-8000-000000000001", r.id, "First", "2026-10-25T01:00:00.000Z");
    ins.run("qs_abcd5678-0000-4000-8000-000000000002", r.id, "Second", "2026-10-25T02:00:00.000Z");
    raw.close();
    const amb = w.ss.search(P, "QS-ABCD", { sort: "OLDEST" });
    assert.deepEqual(amb.hits.filter((h) => h.matchedField === "QUOTE_SHORT_REF").map((h) => h.series?.name), ["First", "Second"]);
    assert.deepEqual(amb.ambiguous, [{ field: "QUOTE_SHORT_REF", prefix: "QS-ABCD", count: 2 }]);
    const narrow = w.ss.search(P, "qs-abcd12");
    assert.deepEqual(narrow.hits.map((h) => h.series?.name), ["First"]);
    assert.deepEqual(narrow.ambiguous, []);
    const tooShort = w.ss.search(P, "QS-AB");
    assert.deepEqual(tooShort.hits, []);
    assert.equal(tooShort.notes.length, 1);
  });

  test("%, _, *, quotes and SQL text are ordinary characters (no wildcard, no SQL)", () => {
    const w = world();
    w.request("100% recycled bags");
    w.request("Plain bags");
    w.request("under_score item");
    assert.deepEqual(w.ss.search(P, "%").hits.map((h) => h.request.title), ["100% recycled bags"]);
    assert.deepEqual(w.ss.search(P, "_").hits.map((h) => h.request.title), ["under_score item"]);
    assert.deepEqual(w.ss.search(P, "*").hits, []);
    assert.deepEqual(w.ss.search(P, "' OR 1=1 --").hits, []);
    assert.deepEqual(w.ss.search(P, "bags'); DROP TABLE procurement_requests; --").hits, []);
    assert.equal(w.ps.list(100, ALL_REQUESTS).length, 3);
  });

  test("results are capped and marked truncated", () => {
    const w = world();
    for (let i = 0; i < 55; i++) w.request(`Bulk item ${i}`);
    const r = w.ss.search(P, "bulk");
    assert.equal(r.hits.length, 50);
    assert.equal(r.truncated, true);
  });

  test("the access scope filters before matching: a principal whose scope excludes the request gets nothing", () => {
    const w = world();
    w.request("Visible to its owner");
    assert.equal(w.ss.search(P, "visible").hits.length, 1);
    const outsider: Principal = { ...P, id: "u_outsider", access: { ...P.access, scope: () => ({ sql: "0 = 1", params: [] }) } };
    const r = w.ss.search(outsider, "visible");
    assert.deepEqual([r.hits, r.total], [[], 0], "nothing matched or counted outside the scope");
  });
});

describe("search HTTP", () => {
  const get = (q: string, host = "127.0.0.1:3000") => new Request(`http://127.0.0.1:3000/api/procurements/search?q=${encodeURIComponent(q)}`, { headers: { host } });

  test("200 with hits; 422 for overlong or control-character input (input echoed); local-only; production 404", async () => {
    const w = world();
    w.request("Searchable");
    const ok = await handleSearch(get("search"), w.ss, { enabled: true, auth: testGate() });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).hits.length, 1);
    const long = await handleSearch(get("x".repeat(201)), w.ss, { enabled: true, auth: testGate() });
    assert.equal(long.status, 422);
    const ctl = await handleSearch(get("a\nb"), w.ss, { enabled: true, auth: testGate() });
    assert.equal(ctl.status, 422);
    assert.equal((await ctl.json()).query, "a\nb");
    assert.equal((await handleSearch(get("search", "evil.example"), w.ss, { enabled: true, auth: testGate() })).status, 403);
    assert.equal((await handleSearch(get("search"), w.ss, { enabled: false, auth: testGate() })).status, 404);
  });
});

// ---------------------------------------------------------------- 25 Oct follow-up: categories, dates, counts

describe("categories, date order and counts (owner feedback 25 Oct)", () => {
  test("a category returns only hits of that matched field; ALL counts every field", async () => {
    const w = world();
    const r = w.request("QT-5 bottles"); // title contains the query
    const s = w.series(r.id, "QT-5 offer", "Kappa", "Quotation No. QT-5\nTotal USD 1");
    await w.extract(r.id, s.seriesId, s.versionId);
    const fields = (category: Parameters<SearchStore["search"]>[2] extends infer O ? O extends { category?: infer C } ? C : never : never) =>
      w.ss.search(P, "QT-5", { category }).hits.map((h) => h.matchedField);
    assert.deepEqual(fields("SUPPLIER_QUOTE_NUMBER"), ["SUPPLIER_QUOTE_NUMBER"]);
    assert.deepEqual(fields("QUOTE_NAME"), ["QUOTE_NAME"]);
    assert.deepEqual(fields("PROCUREMENT_TITLE"), ["REQUEST_TITLE"]);
    assert.deepEqual(fields("QUOTE_REFERENCE"), []);
    assert.deepEqual(fields("REQUEST_ID"), []);
    const all = w.ss.search(P, "QT-5");
    assert.deepEqual([...all.hits.map((h) => h.matchedField)].sort(), ["QUOTE_NAME", "REQUEST_TITLE", "SUPPLIER_QUOTE_NUMBER"]);
    assert.equal(all.total, 3);
    assert.equal(all.totalRequests, 1);
    // Request ID category: full and short forms only.
    assert.deepEqual(w.ss.search(P, r.id, { category: "REQUEST_ID" }).hits.map((h) => h.matchedField), ["REQUEST_ID"]);
    assert.deepEqual(w.ss.search(P, r.id, { category: "QUOTE_NAME" }).hits, []);
  });

  test("several extractions of one version: one hit per stored number row — no join multiplication, no rows dropped", async () => {
    const w = world();
    const r = w.request("Repeat runs");
    const s = w.series(r.id, "Lambda quote", "Lambda", "Quotation No. QT-88\nTotal USD 2");
    const v2 = w.addVersion(r.id, s.seriesId, s.versionId, "Quotation No. QT-88\nTotal USD 3");
    await w.extract(r.id, s.seriesId, s.versionId);
    await w.extract(r.id, s.seriesId, s.versionId, true);
    await w.extract(r.id, s.seriesId, s.versionId, true);
    await w.extract(r.id, s.seriesId, v2);
    const raw = new DatabaseSync(w.path, { readOnly: true });
    const stored = (raw.prepare("SELECT count(*) AS n FROM quote_version_supplier_refs WHERE value_raw = 'QT-88'").get() as { n: number }).n;
    raw.close();
    const res = w.ss.search(P, "QT-88", { category: "SUPPLIER_QUOTE_NUMBER", sort: "OLDEST" });
    assert.equal(stored, 4);
    assert.equal(res.total, 4);
    assert.equal(new Set(res.hits.map((h) => h.supplierRef!.id)).size, 4, "each hit is a different evidence row");
    assert.deepEqual(res.hits.map((h) => h.version!.versionNumber), [1, 1, 1, 2], "the earlier version's numbers are still found");
  });

  test("newest / oldest by the matched record's date; ties ordered by a stable id; dates carry their meaning", () => {
    const w = world();
    const r = w.request("Tie test");
    const raw = new DatabaseSync(w.path);
    const ins = raw.prepare("INSERT INTO quote_series (id, request_id, name, supplier_display_name, created_at) VALUES (?, ?, ?, NULL, ?)");
    ins.run("qs_00000000-0000-4000-8000-00000000000b", r.id, "Tie B", "2026-10-20T00:00:00.000Z");
    ins.run("qs_00000000-0000-4000-8000-00000000000a", r.id, "Tie A", "2026-10-20T00:00:00.000Z");
    ins.run("qs_00000000-0000-4000-8000-00000000000c", r.id, "Tie C (older)", "2026-10-19T00:00:00.000Z");
    ins.run("qs_00000000-0000-4000-8000-00000000000d", r.id, "Tie D (newer)", "2026-10-21T00:00:00.000Z");
    raw.close();
    const names = (sort: "NEWEST" | "OLDEST") => w.ss.search(P, "tie", { category: "QUOTE_NAME", sort }).hits.map((h) => h.series!.name);
    assert.deepEqual(names("NEWEST"), ["Tie D (newer)", "Tie A", "Tie B", "Tie C (older)"]);
    assert.deepEqual(names("OLDEST"), ["Tie C (older)", "Tie A", "Tie B", "Tie D (newer)"]);
    assert.deepEqual(names("NEWEST"), names("NEWEST").slice(), "repeatable");
    const hit = w.ss.search(P, "tie", { category: "QUOTE_NAME" }).hits[0];
    assert.deepEqual(hit.date, { at: "2026-10-21T00:00:00.000Z", meaning: "QUOTE_SERIES_CREATED" });
    const titleHit = w.ss.search(P, "tie", { category: "PROCUREMENT_TITLE" }).hits[0];
    assert.equal(titleHit.date.meaning, "REQUEST_UPDATED");
  });

  test("category and order are applied before the 50-row limit; the total counts everything", () => {
    const w = world();
    for (let i = 0; i < 55; i++) w.request(`Bulk item ${i}`);
    const r = w.request("Holder");
    const raw = new DatabaseSync(w.path);
    raw.prepare("INSERT INTO quote_series (id, request_id, name, supplier_display_name, created_at) VALUES (?, ?, 'Bulk quote (oldest record)', NULL, '2000-01-01T00:00:00.000Z')").run("qs_00000000-0000-4000-8000-0000000000ff", r.id);
    raw.close();
    const all = w.ss.search(P, "bulk", { sort: "NEWEST" });
    assert.equal(all.total, 56);
    assert.equal(all.hits.length, 50);
    assert.equal(all.truncated, true);
    assert.ok(!all.hits.some((h) => h.matchedField === "QUOTE_NAME"), "the oldest record falls outside the newest 50");
    const oldest = w.ss.search(P, "bulk", { sort: "OLDEST" });
    assert.equal(oldest.hits[0].matchedField, "QUOTE_NAME", "sorted over all matches before the limit, not within the first 50");
    const onlyNames = w.ss.search(P, "bulk", { category: "QUOTE_NAME" });
    assert.deepEqual([onlyNames.total, onlyNames.hits.length, onlyNames.truncated], [1, 1, false], "filtered before the limit");
    for (let i = 1; i < all.hits.length; i++) assert.ok(all.hits[i - 1].date.at >= all.hits[i].date.at, "newest first");
  });

  test("no match: zero hits and zero total (the page then shows only the empty state); Request ID, % and _ still literal", () => {
    const w = world();
    const r = w.request("50% off_season");
    const none = w.ss.search(P, "zzz-nothing");
    assert.deepEqual([none.hits.length, none.total, none.totalRequests, none.truncated], [0, 0, 0, false]);
    assert.deepEqual(w.ss.search(P, "%").hits.map((h) => h.request.id), [r.id]);
    assert.deepEqual(w.ss.search(P, "_").hits.map((h) => h.request.id), [r.id]);
    assert.deepEqual(w.ss.search(P, "%%_%").hits, []);
    assert.deepEqual(w.ss.search(P, shortProcurementId(r.id), { category: "REQUEST_ID" }).hits.map((h) => h.matchedField), ["REQUEST_SHORT_REF"]);
  });

  test("HTTP: unknown field or sort → 422; valid ones pass through", async () => {
    const w = world();
    w.request("Http field test");
    const get = (qs: string) => new Request(`http://127.0.0.1:3000/api/procurements/search?${qs}`, { headers: { host: "127.0.0.1:3000" } });
    assert.equal((await handleSearch(get("q=http&field=EVERYTHING"), w.ss, { enabled: true, auth: testGate() })).status, 422);
    assert.equal((await handleSearch(get("q=http&sort=RANDOM"), w.ss, { enabled: true, auth: testGate() })).status, 422);
    const ok = await (await handleSearch(get("q=http&field=PROCUREMENT_TITLE&sort=OLDEST"), w.ss, { enabled: true, auth: testGate() })).json();
    assert.deepEqual([ok.category, ok.sort, ok.total], ["PROCUREMENT_TITLE", "OLDEST", 1]);
  });
});
