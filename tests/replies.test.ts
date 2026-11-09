// Supplier reply tracking (28 Oct, reworked to schema v12; 29 Oct additions, schema v13). No model, translation service or PayPal is called anywhere
// here: drafts come from comparisons of the STORED LA-1 run replayed through a counting test double (MOCK mode, never
// the API budget), on temporary databases. Reply texts and expected results are written by hand.
//
// One test (or more) per requirement of the 28 Oct review: a reply is not a quote version; received ≠ resolved;
// source / unverified sender; unassigned replies; one reply → many questions; several replies; contradictions;
// corrections keep the original; duplicate submissions; concurrent edits; a basis change is not inherited; buyer
// statements are never approved terms; commercial terms need an updated quote; Q numbers are draft-scoped.
// 29 Oct: identical text under a new key is a new reply (flagged, not merged); the basis covers the draft's run, the
// newest run and the reviews; statements are classified (confirms / new condition / unclear); a linked updated quote
// is shown as not extracted / compared / approved until shown otherwise.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import type { ExtractionRun } from "../src/lib/extraction.ts";
import { emptyInput, type ProcurementInput } from "../src/lib/procurement.ts";
import {
  basisChanges,
  checkStatement,
  contradictions,
  copiedNumber,
  questionNumber,
  questionState,
  quoteUpdateFor,
  validateAnswer,
  type AnswerBasis,
  type StoredAnswer,
} from "../src/lib/replies.ts";
import { BudgetStore } from "../src/server/budget/store.ts";
import { ClarificationService } from "../src/server/clarification/service.ts";
import { ClarificationStore } from "../src/server/clarification/store.ts";
import { ComparisonService } from "../src/server/comparison/service.ts";
import { SCHEMA_VERSION, openDatabase } from "../src/server/db/database.ts";
import type { ExtractionModel, ModelReply, ResolvedModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { handleAnswer, handleGetReplies, handleLinkQuote, handleLinkReply, handleSaveReply } from "../src/server/replies/http.ts";
import { REPLY_SCHEMA_V11 } from "../src/server/replies/schema-sql.ts";
import { ReplyService } from "../src/server/replies/service.ts";
import { ReplyStore } from "../src/server/replies/store.ts";
import { generousBudget } from "./helpers/budget.ts";
import { testBuyer, testGate } from "./helpers/principals.ts";

type StoredItem = { id: string; name: string; quantity: number | null; unit: string | null; material: string | null; specification: string | null; customization: string | null };
const STORED = JSON.parse(readFileSync(join("samples", "synthetic", "live-acceptance", "stored-runs.synthetic.json"), "utf8")) as {
  cases: Record<string, { version: { rawText: string; snapshot: { record: { items: StoredItem[] } } }; run: ExtractionRun }>;
};
const P = testBuyer();

// The supplier's replies as the user would paste them (hand-written, SYNTHETIC).
const REPLY_1 = [
  "[SYNTHETIC] Re: clarification",
  "1. We can supply 316 stainless steel. Unit price for 316 is USD 4.80 per pcs, lead time unchanged.",
  "4. Payment terms: 30% deposit, 70% before shipment.",
  "Other points will follow next week.",
].join("\n");
const REPLY_2 = ["[SYNTHETIC] Re: Re: clarification", "Sorry, 316 is not available this month. We can only offer 201.", "Payment terms: 30% deposit, 70% before shipment."].join("\n");
const EX_316 = "We can supply 316 stainless steel. Unit price for 316 is USD 4.80 per pcs";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-replies-test-"));
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

function world(path = join(dir, `replies-${++counter}.sqlite`)) {
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const bs = new BudgetStore(path);
  const cs = new ClarificationStore(path);
  const rs = new ReplyStore(path);
  open.push(ps, qs, es, bs, cs, rs);
  const model = replay();
  const resolveModel = (): ResolvedModel => ({ config: { state: "READY", mode: "MOCK", provider: model.provider, model: model.model }, model }) as ResolvedModel;
  const svc = new ExtractionService(es, { resolveModel, nonce: () => "n", limits: { timeoutMs: 500, maxAttempts: 1, retryDelayMs: 1 }, budget: bs, resolveBudget: generousBudget() });
  const cmp = new ComparisonService(es, { now: () => new Date("2026-10-28T02:00:00Z") });
  const clar = new ClarificationService(cs, cmp);
  const replies = new ReplyService(rs, cs);
  return { path, ps, qs, es, bs, cs, rs, model, svc, clar, replies };
}
type World = ReturnType<typeof world>;

function requestInput(): ProcurementInput {
  const snap = STORED.cases["LA-1"].version.snapshot.record;
  return {
    ...emptyInput(),
    buyerType: "BUSINESS",
    buyerCompany: "Test Co",
    title: "[TEST] replies — LA-1",
    paymentTerms: "50% deposit, 50% before shipment",
    items: snap.items.map((i, n) => ({
      id: null,
      name: i.name,
      quantity: n === 0 ? "250" : i.quantity === null ? "" : String(i.quantity),
      unit: i.unit ?? "",
      material: n === 0 ? "316 stainless steel" : (i.material ?? ""),
      specification: i.specification ?? "",
      customization: i.customization ?? "",
      notes: "",
    })),
  };
}

/** A [TEST] LA-1 request with planted differences, its quote v1, one replayed run and a draft. */
async function setup(w: World) {
  const snap = STORED.cases["LA-1"].version.snapshot.record;
  const v = validateProcurementInput(requestInput(), "create");
  assert.ok(v.ok);
  const r = w.ps.create(v.value, "USER_INPUT");
  const ids = Object.fromEntries(snap.items.map((old) => [old.id, r.items.find((x) => x.name === old.name)!.id]));
  const saved = w.qs.createSeries(r.id, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: 1,
    name: "[TEST] LA-1",
    supplierDisplayName: null,
    version: { rawText: STORED.cases["LA-1"].version.rawText, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "stored-runs.synthetic.json", supplierQuoteDate: null, revisionNote: null },
  });
  assert.ok(saved.status === "CREATED");
  w.model.next = { raw: STORED.cases["LA-1"].run.rawOutput!, ids };
  const o = await w.svc.run(P, r.id, saved.series.id, saved.version.id, { idempotencyKey: randomUUID(), rerun: true });
  assert.equal(o.status, "FINISHED");
  const run = (o as { run: ExtractionRun }).run;
  const d = w.clar.create(P, r.id, saved.series.id, saved.version.id, run.id, null, null);
  assert.equal(d.status, "CREATED");
  const draft = (d as { draft: { id: string; generated: { questions: { id: string; template: string; field: string }[] } } }).draft;
  return { r, seriesId: saved.series.id, v1: saved.version.id, run, draft };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const q = (s: Setup, template: string) => s.draft.generated.questions.find((x) => x.template === template)!.id;

function saveReply(w: World, s: Setup, text = REPLY_1, extra: Record<string, unknown> = {}) {
  const out = w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: text, source: "TEST_FIXTURE", ...extra }, randomUUID());
  assert.ok(out.status === "CREATED", JSON.stringify(out));
  return out.reply;
}

function linkReply(w: World, s: Setup, replyId: string, revision = 1) {
  const out = w.replies.linkToDraft(P, s.r.id, s.draft.id, replyId, revision, null, randomUUID());
  assert.ok(out.status === "CREATED" || out.status === "EXISTING", JSON.stringify(out));
  return out.link;
}

const latestOf = (w: World, s: Setup, questionId: string) => w.replies.view(P, s.r.id, s.draft.id)!.questions.find((x) => x.questionId === questionId)!;

function addVersion(w: World, s: Setup, text: string) {
  const series = w.qs.listSeries(s.r.id).find((x) => x.id === s.seriesId)!;
  const latest = series.versions[series.versions.length - 1];
  const out = w.qs.addVersion(s.r.id, s.seriesId, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: w.ps.get(s.r.id)!.revision,
    expectedLatestVersionId: latest.id,
    version: { rawText: text, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: "updated quote", supplierQuoteDate: null, revisionNote: null },
  });
  assert.ok(out.status === "CREATED", JSON.stringify(out));
  return out.version.id;
}

const counts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (t: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
    return {
      runs: n("quote_extraction_runs"),
      reviews: n("quote_extraction_reviews"),
      ledger: n("ai_budget_ledger"),
      versions: n("quote_versions"),
      requests: n("procurement_requests"),
      payments: n("sandbox_payment_records"),
      drafts: n("clarification_drafts"),
      revisions: n("clarification_draft_revisions"),
      supplierReplies: n("supplier_replies"),
      quoteLinks: n("supplier_reply_quote_links"),
      links: n("clarification_replies"),
      answers: n("clarification_answers"),
    };
  } finally {
    db.close();
  }
};
const others = (c: ReturnType<typeof counts>) => ({ ...c, supplierReplies: 0, quoteLinks: 0, links: 0, answers: 0 });

// ---------------------------------------------------------------- pure

describe("pure rules", () => {
  test("Q number = generated order within ONE draft; copied list number = place among the selected ones", () => {
    const g = { questions: [{ id: "a" }, { id: "b" }, { id: "c" }] } as unknown as Parameters<typeof questionNumber>[0];
    assert.deepEqual(["a", "b", "c", "x"].map((id) => questionNumber(g, id)), [1, 2, 3, null]);
    assert.deepEqual(["a", "b", "c"].map((id) => copiedNumber(["a", "c"], id)), [1, null, 2]);
  });

  test("validation: excerpt unless not answered; buyer statement only when answered; limits", () => {
    assert.ok(validateAnswer({ status: "ANSWERED", excerpt: "x", buyerStatement: "y", statementKind: "CONFIRMS_ORIGINAL" }).ok);
    assert.ok(!validateAnswer({ status: "ANSWERED", excerpt: "x", buyerStatement: "y" }).ok, "a statement needs a classification");
    assert.ok(!validateAnswer({ status: "ANSWERED", excerpt: "x", statementKind: "UNCLEAR" }).ok, "a classification needs a statement");
    assert.ok(!validateAnswer({ status: "ANSWERED", excerpt: "x", buyerStatement: "y", statementKind: "AGREED" }).ok);
    assert.ok(validateAnswer({ status: "NOT_ANSWERED" }).ok);
    assert.ok(!validateAnswer({ status: "NOT_ANSWERED", excerpt: "x" }).ok);
    assert.ok(!validateAnswer({ status: "ANSWERED" }).ok);
    assert.ok(!validateAnswer({ status: "PARTLY_ANSWERED", excerpt: "x", buyerStatement: "y", statementKind: "UNCLEAR" }).ok);
    assert.ok(!validateAnswer({ status: "CONFIRMED", excerpt: "x" }).ok);
    assert.ok(!validateAnswer({ status: "ANSWERED", excerpt: "x".repeat(2001) }).ok);
    assert.ok(!validateAnswer({ status: "ANSWERED", excerpt: "a\u0007b" }).ok);
  });

  test("statement check lists values not in the supplier's words; the quote update follows the buyer's classification", () => {
    assert.deepEqual(checkStatement("Unit price USD 4.80 per pcs", EX_316).notInExcerpt, []);
    assert.ok(checkStatement("Unit price USD 4.50 per pcs", EX_316).notInExcerpt.length >= 1);
    assert.ok(checkStatement("Unit price 1.800,00 USD", EX_316).unreadable.length >= 1);
    const st = (kind: StoredAnswer["statementKind"], statement: string | null = "x") => ({ status: "ANSWERED", buyerStatement: statement, statementKind: kind }) as StoredAnswer;
    for (const f of ["unitPrice", "quantity", "material", "currency", "leadTime", "paymentTerms"]) {
      assert.equal(quoteUpdateFor(st("PROPOSES_NEW"), f), "UPDATED_QUOTE_NEEDED", f);
      assert.equal(quoteUpdateFor(st("CONFIRMS_ORIGINAL"), f), "NONE", f);
      assert.equal(quoteUpdateFor(st("UNCLEAR"), f), "MANUAL_REVIEW", f);
      assert.equal(quoteUpdateFor(st(null), f), "MANUAL_REVIEW", `${f}: unclassified (older) statement`);
    }
    assert.equal(quoteUpdateFor(st("PROPOSES_NEW"), "pairing"), "MANUAL_REVIEW", "pairing is never a term change");
    assert.equal(quoteUpdateFor(st(null, null), "material"), "NONE", "no statement → nothing to update");
    assert.equal(quoteUpdateFor(null, "material"), "NONE");
  });

  test("state, basis and contradictions", () => {
    const a = (status: StoredAnswer["status"], buyerStatement: string | null, replyId = "l1") => ({ status, buyerStatement, replyId }) as StoredAnswer;
    assert.equal(questionState(null), "OPEN");
    assert.equal(questionState(a("ANSWERED", null)), "ANSWERED");
    assert.equal(questionState(a("ANSWERED", "x")), "STATEMENT_RECORDED");
    const now: AnswerBasis = { rules: "basis-2", requestRevision: 2, latestQuoteVersionNumber: 1, sentRevision: 1, runId: "qx_a", baseRunId: null, newestRunId: "qx_a", reviews: [{ runId: "qx_a", count: 0, lastId: null }] };
    assert.deepEqual(basisChanges(now, now), []);
    assert.deepEqual(basisChanges(null, now), ["BASIS_NOT_RECORDED"]);
    assert.deepEqual(basisChanges({ requestRevision: 2, latestQuoteVersionNumber: 1 }, now), ["BASIS_INCOMPLETE"], "v12 two-field basis is not enough");
    assert.deepEqual(basisChanges({ ...now, requestRevision: 1 }, now), ["REQUEST_REVISED"]);
    assert.deepEqual(basisChanges({ ...now, latestQuoteVersionNumber: 0 }, now), ["NEWER_QUOTE_VERSION"]);
    assert.deepEqual(basisChanges({ ...now, sentRevision: 2 }, now), ["SENT_REVISION_DIFFERS"]);
    assert.deepEqual(basisChanges({ ...now, newestRunId: "qx_old" }, now), ["NEWER_RUN"]);
    assert.deepEqual(basisChanges({ ...now, reviews: [{ runId: "qx_a", count: 1, lastId: "qxr_1" }] }, now), ["REVIEWS_CHANGED"]);
    const sr = (id: string) => (id === "l1" ? "sr1" : "sr2");
    assert.deepEqual(contradictions([a("ANSWERED", "x", "l1"), a("PARTLY_ANSWERED", null, "l1")], sr), []); // same reply: a correction, not a contradiction
    assert.equal(contradictions([a("ANSWERED", "x", "l1"), a("NOT_ANSWERED", null, "l2")], sr).length, 2);
    assert.deepEqual(contradictions([a("ANSWERED", "x", "l1"), a("ANSWERED", "x", "l2")], sr), []);
  });
});

// ---------------------------------------------------------------- reply ≠ quote

describe("a reply is not a quote version", () => {
  test("saving a reply creates no quote version, keeps the latest quote, changes no draft basis, and settles nothing", async () => {
    const w = world();
    const s = await setup(w);
    const before = counts(w.path);
    const reply = saveReply(w, s, REPLY_1, { source: "USER_PASTE", senderAsTyped: "Sales (as signed)", receivedOn: "2026-10-28", channelNote: "e-mail" });
    const after = counts(w.path);
    assert.deepEqual(others(after), others(before));
    assert.equal(after.supplierReplies, 1);
    assert.equal(w.qs.listSeries(s.r.id)[0].versions.length, 1, "no new quote version");
    assert.deepEqual(w.clar.open(P, s.r.id, s.draft.id)!.basis.changes, [], "the draft is not out of date");
    // Source and unverified sender are stored as entered; not assigned to any draft yet.
    assert.equal(reply.source, "USER_PASTE");
    assert.equal(reply.senderAsTyped, "Sales (as signed)");
    assert.equal(reply.receivedOn, "2026-10-28");
    assert.deepEqual(reply.linkedDraftIds, []);
    assert.equal(reply.fromQuoteVersion, null);
    const view = w.replies.view(P, s.r.id, s.draft.id)!;
    assert.equal(view.seriesReplies.length, 1);
    assert.equal(view.links.length, 0);
    assert.ok(view.questions.every((x) => x.state === "OPEN"));
    // Linking still settles nothing.
    linkReply(w, s, reply.id);
    assert.ok(w.replies.view(P, s.r.id, s.draft.id)!.questions.every((x) => x.state === "OPEN"));
    assert.deepEqual(w.clar.open(P, s.r.id, s.draft.id)!.basis.changes, []);
  });

  test("same key + same payload replays the original; same key + other payload refused; a new key keeps an identical text as its own reply", async () => {
    const w = world();
    const s = await setup(w);
    const key = randomUUID();
    const first = { rawText: REPLY_1, receivedOn: "2026-10-27", channelNote: "e-mail" };
    const a = w.replies.saveReply(P, s.r.id, s.seriesId, first, key);
    assert.equal(a.status, "CREATED");
    assert.ok(a.status === "CREATED");
    assert.deepEqual(a.reply.sameTextAs, []);
    const replay = w.replies.saveReply(P, s.r.id, s.seriesId, first, key);
    assert.ok(replay.status === "REPLAYED" && replay.reply.id === a.reply.id, "retry returns the original row");
    assert.equal(w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: REPLY_2 }, key).status, "KEY_REUSED");
    assert.equal(w.replies.saveReply(P, s.r.id, s.seriesId, { ...first, channelNote: "WeChat" }, key).status, "KEY_REUSED", "same key, other channel → refused");
    assert.equal(counts(w.path).supplierReplies, 1);
    // The same text received again (another day, another channel) under a new key: a separate reply, flagged.
    const again = w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: REPLY_1, receivedOn: "2026-10-28", channelNote: "WeChat" }, randomUUID());
    assert.ok(again.status === "CREATED");
    assert.notEqual(again.reply.id, a.reply.id);
    assert.deepEqual(again.reply.sameTextAs, [a.reply.id]);
    assert.equal(again.reply.receivedOn, "2026-10-28");
    assert.equal(again.reply.channelNote, "WeChat");
    const firstNow = w.rs.supplierReply(a.reply.id)!;
    assert.deepEqual(firstNow.sameTextAs, [again.reply.id]);
    assert.equal(firstNow.receivedOn, "2026-10-27");
    assert.equal(firstNow.channelNote, "e-mail");
    assert.equal(counts(w.path).supplierReplies, 2);
    // A corrected paste is a new reply that names the original; the original stays.
    const fixed = w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: `${REPLY_1}\n(typo fixed)`, correctsReplyId: a.reply.id }, randomUUID());
    assert.ok(fixed.status === "CREATED" && fixed.reply.sameTextAs.length === 0);
    assert.ok(fixed.status === "CREATED" && fixed.reply.correctsReplyId === a.reply.id);
    assert.equal(w.rs.supplierReply(a.reply.id)!.rawText, REPLY_1);
    assert.equal(w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: "" }, randomUUID()).status, "INVALID");
    assert.equal(w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: "x", receivedOn: "28/10/2026" }, randomUUID()).status, "INVALID");
    assert.equal(w.replies.saveReply(P, s.r.id, s.seriesId, { rawText: "x", senderAsTyped: "a\nb" }, randomUUID()).status, "INVALID");
    // Another request's series → not found; correcting a reply of another series → not found.
    const other = await setup(w);
    assert.equal(w.replies.saveReply(P, other.r.id, s.seriesId, { rawText: "x" }, randomUUID()).status, "NOT_FOUND");
    assert.equal(w.replies.saveReply(P, other.r.id, other.seriesId, { rawText: "y", correctsReplyId: a.reply.id }, randomUUID()).status, "NOT_FOUND");
  });

  test("an updated quote is linked explicitly; only the quote version is a quote; other series refused", async () => {
    const w = world();
    const s = await setup(w);
    const reply = saveReply(w, s);
    const v2 = addVersion(w, s, "[SYNTHETIC] Revised quotation: 316 stainless steel, USD 4.80 per pcs");
    const before = counts(w.path);
    const key = randomUUID();
    const l = w.replies.linkQuote(P, s.r.id, reply.id, v2, null, key);
    assert.ok(l.status === "CREATED" && l.reply.updatedQuotes.map((x) => x.versionNumber).join() === "2");
    assert.equal(w.replies.linkQuote(P, s.r.id, reply.id, v2, null, key).status, "REPLAYED");
    assert.equal(w.replies.linkQuote(P, s.r.id, reply.id, v2, null, randomUUID()).status, "EXISTING");
    const after = counts(w.path);
    assert.equal(after.versions, before.versions, "linking creates no version");
    assert.equal(after.quoteLinks, 1);
    const other = await setup(w);
    assert.equal(w.replies.linkQuote(P, s.r.id, reply.id, other.v1, null, randomUUID()).status, "NOT_ELIGIBLE");
  });
});

// ---------------------------------------------------------------- answers

describe("answers per question", () => {
  async function linked() {
    const w = world();
    const s = await setup(w);
    const reply = saveReply(w, s);
    const link = linkReply(w, s, reply.id);
    return { w, s, reply, link };
  }

  test("one reply answers several questions; excerpt must be in the reply; unchanged; conflict; replay / key reuse", async () => {
    const { w, s, link } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const pay = q(s, "PAYMENT_DIFFERS");
    assert.equal(w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: "We can supply 304 stainless steel." }, randomUUID()).status, "EXCERPT_NOT_IN_REPLY");
    assert.equal(counts(w.path).answers, 0);
    const k1 = randomUUID();
    const a1 = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316 }, k1);
    assert.ok(a1.status === "SAVED");
    assert.deepEqual(a1.answer.basis, { rules: "basis-2", requestRevision: 1, latestQuoteVersionNumber: 1, sentRevision: 1, runId: s.run.id, baseRunId: null, newestRunId: s.run.id, reviews: [{ runId: s.run.id, count: 0, lastId: null }] });
    assert.equal(w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316 }, k1).status, "REPLAYED");
    assert.equal(w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "PARTLY_ANSWERED", excerpt: EX_316 }, k1).status, "KEY_REUSED");
    assert.equal(w.replies.answer(P, s.r.id, s.draft.id, link.id, material, a1.answer.id, { status: "ANSWERED", excerpt: EX_316 }, randomUUID()).status, "UNCHANGED");
    const stale = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "NOT_ANSWERED" }, randomUUID());
    assert.ok(stale.status === "CONFLICT" && stale.current?.id === a1.answer.id);
    // The same reply answers another question.
    const p1 = w.replies.answer(P, s.r.id, s.draft.id, link.id, pay, null, { status: "ANSWERED", excerpt: "Payment terms: 30% deposit, 70% before shipment." }, randomUUID());
    assert.ok(p1.status === "SAVED");
    assert.equal(counts(w.path).answers, 2);
  });

  test("buyer statement: the buyer's classified wording; a new condition needs an updated quote; never an approved term or payment amount", async () => {
    const { w, s, link, reply } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const a = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 stainless steel at USD 4.80 per pcs", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(a.status === "SAVED");
    assert.deepEqual(a.statementCheck, { notInExcerpt: [], unreadable: [] });
    const st = latestOf(w, s, material);
    assert.equal(st.state, "STATEMENT_RECORDED");
    assert.equal(st.quoteUpdate, "UPDATED_QUOTE_NEEDED");
    assert.equal(st.replyReceived, true);
    assert.equal(st.approved, false);
    assert.equal(st.basisCurrent, true);
    const list = w.replies.buyerStatements(P, s.r.id)!;
    assert.equal(list.length, 1);
    assert.equal(list[0].usableAsApprovedTerm, false);
    assert.equal(list[0].usableAsPaymentAmount, false);
    assert.equal(list[0].quoteUpdate, "UPDATED_QUOTE_NEEDED");
    assert.equal(list[0].statementKind, "PROPOSES_NEW");
    assert.equal(list[0].supplierReplyId, reply.id);
    assert.equal(list[0].field, "material");
    // A statement whose amount is not in the supplier's words is saved (the buyer's wording) but flagged for review.
    const b = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, a.answer.id, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 at USD 4.50 per pcs", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(b.status === "SAVED" && b.statementCheck!.notInExcerpt.length >= 1);
    // Withdrawn: a new reading without a statement; the list follows the newest reading.
    const c = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, b.answer.id, { status: "PARTLY_ANSWERED", excerpt: EX_316 }, randomUUID());
    assert.ok(c.status === "SAVED");
    assert.deepEqual(w.replies.buyerStatements(P, s.r.id), []);
    assert.equal(latestOf(w, s, material).history.length, 3, "earlier readings are kept");
  });

  test("a basis change is not inherited: newer quote version or request revision → not current until recorded again", async () => {
    const { w, s, link } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const a = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 at USD 4.80 per pcs", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(a.status === "SAVED");
    addVersion(w, s, "[SYNTHETIC] Revised quotation v2");
    assert.equal(latestOf(w, s, material).basisCurrent, false);
    assert.deepEqual(w.replies.buyerStatements(P, s.r.id)![0].basisChanges, ["NEWER_QUOTE_VERSION"]);
    assert.equal(latestOf(w, s, material).history.length, 1, "history kept; nothing re-recorded automatically");
    // Recording the same reading again on the new basis is a new answer (not "unchanged").
    const again = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, a.answer.id, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 at USD 4.80 per pcs", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(again.status === "SAVED");
    assert.equal(latestOf(w, s, material).basisCurrent, true);
    // Request revised → not current again.
    const rec = w.ps.get(s.r.id)!;
    const v = validateProcurementInput({ ...requestInput(), title: "[TEST] replies — LA-1 (edited)", items: requestInput().items.map((it, i) => ({ ...it, id: rec.items[i].id })) }, "update");
    assert.ok(v.ok);
    assert.equal(w.ps.update(s.r.id, rec.revision, v.value).status, "UPDATED");
    assert.deepEqual(latestOf(w, s, material).basisChanges, ["REQUEST_REVISED"]);
    // A regenerated draft (new basis) starts with every question open: nothing is carried over.
    const regen = w.clar.create(P, s.r.id, s.seriesId, s.v1, s.run.id, null, s.draft.id);
    assert.ok(regen.status === "CREATED");
    const fresh = w.replies.view(P, s.r.id, regen.draft.id)!;
    assert.ok(fresh.questions.every((x) => x.state === "OPEN"));
    assert.equal(fresh.links.length, 0);
  });

  test("several replies: a later reply continues the history; disagreeing readings are flagged as contradictions", async () => {
    const { w, s, link } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const a = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 at USD 4.80 per pcs", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(a.status === "SAVED");
    const r2 = saveReply(w, s, REPLY_2);
    const l2 = linkReply(w, s, r2.id);
    // The excerpt is checked against THIS reply's text.
    assert.equal(w.replies.answer(P, s.r.id, s.draft.id, l2.id, material, a.answer.id, { status: "ANSWERED", excerpt: EX_316 }, randomUUID()).status, "EXCERPT_NOT_IN_REPLY");
    const b = w.replies.answer(P, s.r.id, s.draft.id, l2.id, material, a.answer.id, { status: "PARTLY_ANSWERED", excerpt: "316 is not available this month. We can only offer 201." }, randomUUID());
    assert.ok(b.status === "SAVED");
    const st = latestOf(w, s, material);
    assert.equal(st.state, "PARTLY_ANSWERED");
    assert.equal(st.latest!.replyId, l2.id);
    assert.equal(st.contradictions.length, 2);
    assert.equal(st.copiedIn.length, 2);
    // Statement again from reply 2 with different wording: still flagged against reply 1's reading.
    const c = w.replies.answer(P, s.r.id, s.draft.id, l2.id, material, b.answer.id, { status: "ANSWERED", excerpt: "We can only offer 201.", buyerStatement: "only 201 offered", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(c.status === "SAVED");
    assert.equal(w.replies.buyerStatements(P, s.r.id)![0].contradicted, true);
  });

  test("classification: confirms the quoted condition / new condition / unclear; pairing never needs an updated quote", async () => {
    const { w, s, link } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const pay = q(s, "PAYMENT_DIFFERS");
    const a = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 offered", statementKind: "CONFIRMS_ORIGINAL" }, randomUUID());
    assert.ok(a.status === "SAVED");
    assert.equal(latestOf(w, s, material).quoteUpdate, "NONE");
    const b = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, a.answer.id, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 offered", statementKind: "UNCLEAR" }, randomUUID());
    assert.ok(b.status === "SAVED", "a new classification is a new reading");
    assert.equal(latestOf(w, s, material).quoteUpdate, "MANUAL_REVIEW");
    const c = w.replies.answer(P, s.r.id, s.draft.id, link.id, pay, null, { status: "ANSWERED", excerpt: "Payment terms: 30% deposit, 70% before shipment.", buyerStatement: "30 / 70", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(c.status === "SAVED");
    assert.equal(latestOf(w, s, pay).quoteUpdate, "UPDATED_QUOTE_NEEDED");
    assert.ok(w.replies.buyerStatements(P, s.r.id)!.every((x) => x.usableAsApprovedTerm === false && x.usableAsPaymentAmount === false));
    assert.equal(w.replies.answer(P, s.r.id, s.draft.id, link.id, pay, c.answer.id, { status: "ANSWERED", excerpt: "Payment terms: 30% deposit, 70% before shipment.", buyerStatement: "30 / 70" }, randomUUID()).status, "INVALID");
    // The DB refuses a statement without its classification too.
    const db = new DatabaseSync(w.path);
    try {
      assert.throws(
        () =>
          db
            .prepare("INSERT INTO clarification_answers (id, draft_id, reply_id, question_id, status, excerpt, buyer_statement, statement_kind, note, basis_json, supersedes_id, idempotency_key, fingerprint, created_at) VALUES (?, ?, ?, ?, 'ANSWERED', ?, 'x', NULL, NULL, NULL, ?, ?, ?, ?)")
            .run(`ca_${randomUUID()}`, s.draft.id, link.id, pay, "Payment terms", c.answer.id, randomUUID(), "0".repeat(64), new Date().toISOString()),
        /classification/,
      );
    } finally {
      db.close();
    }
  });

  test("basis covers the draft's run, a newer run of the version and review changes; history kept, nothing inherited", async () => {
    const { w, s, link } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const a = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 at USD 4.80", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(a.status === "SAVED");
    const basis = a.answer.basis as AnswerBasis;
    assert.equal(basis.rules, "basis-2");
    assert.equal(basis.runId, s.run.id);
    assert.equal(basis.newestRunId, s.run.id);
    assert.equal(basis.sentRevision, 1);
    assert.deepEqual(basis.reviews, [{ runId: s.run.id, count: 0, lastId: null }]);
    // A review of the draft's run → REVIEWS_CHANGED.
    const rv = w.svc.review(P, s.r.id, s.seriesId, s.v1, s.run.id, { idempotencyKey: randomUUID(), fieldPath: "quoteDate", action: "CONFIRM", valueText: null, requestItemId: null, basedOnReviewId: null });
    assert.equal((rv as { status: string }).status, "CREATED");
    assert.deepEqual(latestOf(w, s, material).basisChanges, ["REVIEWS_CHANGED"]);
    // A newer extraction run of the same version → NEWER_RUN as well.
    const snap = STORED.cases["LA-1"].version.snapshot.record;
    const rec = w.ps.get(s.r.id)!;
    w.model.next = { raw: STORED.cases["LA-1"].run.rawOutput!, ids: Object.fromEntries(snap.items.map((old) => [old.id, rec.items.find((x) => x.name === old.name)!.id])) };
    const o = await w.svc.run(P, s.r.id, s.seriesId, s.v1, { idempotencyKey: randomUUID(), rerun: true });
    assert.equal(o.status, "FINISHED");
    assert.deepEqual(latestOf(w, s, material).basisChanges, ["NEWER_RUN", "REVIEWS_CHANGED"]);
    assert.equal(w.replies.buyerStatements(P, s.r.id)![0].basisChanges.length, 2);
    assert.equal(latestOf(w, s, material).history.length, 1);
    // Recorded again on the new basis: current; the earlier reading stays in the history.
    const again = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, a.answer.id, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316 at USD 4.80", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(again.status === "SAVED");
    assert.deepEqual(latestOf(w, s, material).basisChanges, []);
    assert.equal(latestOf(w, s, material).history.length, 2);
  });

  test("a linked updated quote shows as not extracted, not compared, not approved until shown otherwise", async () => {
    const { w, s, reply } = await linked();
    const v2 = addVersion(w, s, "[SYNTHETIC] Revised quotation: 316 stainless steel, USD 4.80 per pcs");
    const l = w.replies.linkQuote(P, s.r.id, reply.id, v2, null, randomUUID());
    assert.ok(l.status === "CREATED");
    assert.deepEqual(l.reply.updatedQuotes.map((u) => [u.versionNumber, u.finishedRuns]), [[2, 0]]);
    assert.deepEqual(w.replies.updatedQuoteStatus(P, s.r.id, s.seriesId, v2), { versionId: v2, linkedFromReplies: [reply.id], finishedRuns: 0, comparisonRecorded: false, approved: false });
    const snap = STORED.cases["LA-1"].version.snapshot.record;
    const rec = w.ps.get(s.r.id)!;
    w.model.next = { raw: STORED.cases["LA-1"].run.rawOutput!, ids: Object.fromEntries(snap.items.map((old) => [old.id, rec.items.find((x) => x.name === old.name)!.id])) };
    await w.svc.run(P, s.r.id, s.seriesId, v2, { idempotencyKey: randomUUID(), rerun: true });
    const after = w.replies.updatedQuoteStatus(P, s.r.id, s.seriesId, v2)!;
    assert.ok(after.finishedRuns >= 1);
    assert.equal(after.comparisonRecorded, false);
    assert.equal(after.approved, false);
  });

  test("linking: same reply twice → existing; other series → not eligible; bad revision → not eligible; another request → not found", async () => {
    const { w, s, reply, link } = await linked();
    const again = w.replies.linkToDraft(P, s.r.id, s.draft.id, reply.id, 1, null, randomUUID());
    assert.ok(again.status === "EXISTING" && again.link.id === link.id);
    const other = await setup(w);
    const foreign = saveReply(w, other, "[SYNTHETIC] other supplier");
    assert.equal(w.replies.linkToDraft(P, s.r.id, s.draft.id, foreign.id, 1, null, randomUUID()).status, "NOT_FOUND"); // reply of another request
    assert.equal(w.replies.linkToDraft(P, other.r.id, other.draft.id, foreign.id, 99, null, randomUUID()).status, "NOT_ELIGIBLE");
    assert.equal(w.replies.view(P, other.r.id, s.draft.id), null);
    assert.equal(w.replies.answer(P, other.r.id, other.draft.id, link.id, q(s, "MATERIAL_DIFFERS"), null, { status: "NOT_ANSWERED" }, randomUUID()).status, "NOT_FOUND");
  });

  test("database refuses what the app refuses: excerpt not in reply, second first answer, foreign question, wrong-series links, updates and deletes", async () => {
    const { w, s, link, reply } = await linked();
    const material = q(s, "MATERIAL_DIFFERS");
    const ok = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "NOT_ANSWERED" }, randomUUID());
    assert.ok(ok.status === "SAVED");
    const other = await setup(w);
    const db = new DatabaseSync(w.path);
    try {
      const ins = (question: string, status: string, excerpt: string | null, supersedes: string | null) =>
        db
          .prepare("INSERT INTO clarification_answers (id, draft_id, reply_id, question_id, status, excerpt, buyer_statement, note, basis_json, supersedes_id, idempotency_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)")
          .run(`ca_${randomUUID()}`, s.draft.id, link.id, question, status, excerpt, supersedes, randomUUID(), "0".repeat(64), new Date().toISOString());
      assert.throws(() => ins(material, "ANSWERED", "not in the reply", ok.answer.id), /excerpt must occur/);
      assert.throws(() => ins(material, "NOT_ANSWERED", null, null), /UNIQUE/);
      assert.throws(() => ins("NOPE:x", "NOT_ANSWERED", null, null), /does not match/);
      assert.throws(() => ins(material, "ANSWERED", null, ok.answer.id), /CHECK/);
      assert.throws(
        () => db.prepare("INSERT INTO clarification_replies (id, draft_id, supplier_reply_id, sent_revision, note, save_key, created_at) VALUES (?, ?, ?, 1, NULL, ?, ?)").run(`cr_${randomUUID()}`, other.draft.id, reply.id, randomUUID(), new Date().toISOString()),
        /quote series/,
      );
      assert.throws(
        () => db.prepare("INSERT INTO supplier_reply_quote_links (id, reply_id, quote_version_id, note, save_key, created_at) VALUES (?, ?, ?, NULL, ?, ?)").run(`srq_${randomUUID()}`, reply.id, other.v1, randomUUID(), new Date().toISOString()),
        /same|series/,
      );
      for (const t of ["supplier_replies", "clarification_replies", "clarification_answers"]) {
        assert.throws(() => db.exec(`UPDATE ${t} SET created_at = created_at`), /immutable|append-only/, t);
        assert.throws(() => db.exec(`DELETE FROM ${t}`), /cannot be deleted|append-only/, t);
      }
    } finally {
      db.close();
    }
  });

  test("no model, no PayPal, no budget, no quote / extraction / draft writes", async () => {
    const { w, s, link } = await linked();
    const calls = w.model.calls;
    const before = counts(w.path);
    for (const x of s.draft.generated.questions) w.replies.answer(P, s.r.id, s.draft.id, link.id, x.id, latestOf(w, s, x.id).latest?.id ?? null, { status: "NOT_ANSWERED" }, randomUUID());
    w.replies.buyerStatements(P, s.r.id);
    assert.equal(w.model.calls, calls);
    const after = counts(w.path);
    assert.deepEqual(others(after), others(before));
    assert.equal(after.answers, s.draft.generated.questions.length);
    for (const f of ["src/lib/replies.ts", "src/server/replies/store.ts", "src/server/replies/service.ts", "src/server/replies/http.ts"]) {
      const imports = readFileSync(f, "utf8").split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
      assert.ok(!/extraction\/(model|anthropic|service)|payments\/|@anthropic-ai|paypal|comparison\/|quotes\/store/i.test(imports), f);
    }
  });
});

// ---------------------------------------------------------------- HTTP

describe("HTTP", () => {
  const opts = { enabled: true, auth: testGate() };
  const req = (method: string, body?: unknown) =>
    new Request("http://127.0.0.1:3000/api/x", { method, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("save reply / link / quote link / answer: unknown fields 422, bad ids 404, 201 / 200, conflict 409, excerpt 422, guard 403", async () => {
    const w = world();
    const s = await setup(w);
    assert.equal((await handleSaveReply(req("POST", { saveKey: randomUUID(), rawText: REPLY_1, contentKind: "SUPPLEMENT" }), s.r.id, s.seriesId, w.replies, opts)).status, 422);
    const saved = await handleSaveReply(req("POST", { saveKey: randomUUID(), rawText: REPLY_1 }), s.r.id, s.seriesId, w.replies, opts);
    assert.equal(saved.status, 201);
    const replyId = ((await saved.json()) as { reply: { id: string } }).reply.id;
    const again = await handleSaveReply(req("POST", { saveKey: randomUUID(), rawText: REPLY_1 }), s.r.id, s.seriesId, w.replies, opts);
    assert.equal(again.status, 201, "same text, new key → a new reply");
    assert.deepEqual(((await again.json()) as { possibleDuplicateOf: string[] }).possibleDuplicateOf, [replyId]);
    assert.equal((await handleGetReplies(req("GET"), s.r.id, "cd_nope", w.replies, opts)).status, 404);
    assert.equal((await handleLinkReply(req("POST", { saveKey: randomUUID(), reply: replyId, sentRevision: 1, rawText: "x" }), s.r.id, s.draft.id, w.replies, opts)).status, 422);
    const linked = await handleLinkReply(req("POST", { saveKey: randomUUID(), reply: replyId, sentRevision: 1 }), s.r.id, s.draft.id, w.replies, opts);
    assert.equal(linked.status, 201);
    const linkId = ((await linked.json()) as { link: { id: string } }).link.id;
    assert.equal((await handleLinkQuote(req("POST", { saveKey: randomUUID(), version: s.v1 }), s.r.id, s.seriesId, replyId, w.replies, opts)).status, 201);
    const material = s.draft.generated.questions.find((x) => x.template === "MATERIAL_DIFFERS")!.id;
    const base = { link: linkId, question: material, expectedPrevious: null };
    assert.equal((await handleAnswer(req("POST", { ...base, key: randomUUID(), status: "ANSWERED", excerpt: "x", confirmedTerm: "y" }), s.r.id, s.draft.id, w.replies, opts)).status, 422);
    const notIn = await handleAnswer(req("POST", { ...base, key: randomUUID(), status: "ANSWERED", excerpt: "304xxx" }), s.r.id, s.draft.id, w.replies, opts);
    assert.equal(((await notIn.json()) as { code: string }).code, "EXCERPT_NOT_IN_REPLY");
    assert.equal((await handleAnswer(req("POST", { ...base, key: randomUUID(), status: "NOT_ANSWERED" }), s.r.id, s.draft.id, w.replies, opts)).status, 200);
    assert.equal((await handleAnswer(req("POST", { ...base, key: randomUUID(), status: "NOT_ANSWERED" }), s.r.id, s.draft.id, w.replies, opts)).status, 409);
    const foreign = new Request("http://127.0.0.1:3000/api/x", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal((await handleSaveReply(foreign, s.r.id, s.seriesId, w.replies, opts)).status, 403);
  });
});

// ---------------------------------------------------------------- migration

describe("schema v12 / v13 migrations", () => {
  test("v11 rows are carried over: reply text copied from its quote version, link and answer ids kept, statement kept, basis unknown", async () => {
    const w = world();
    const s = await setup(w);
    const v2 = addVersion(w, s, REPLY_1);
    for (const x of [w.ps, w.qs, w.es, w.bs, w.cs, w.rs]) x.close();
    // Turn the file into a genuine v11 file with v11 reply rows.
    const raw = new DatabaseSync(w.path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(
      `DROP TABLE clarification_answers; DROP TABLE clarification_replies; DROP TABLE supplier_reply_quote_links; DROP TABLE supplier_replies;
       ${REPLY_SCHEMA_V11} PRAGMA user_version = 11;`,
    );
    const linkId = `cr_${randomUUID()}`;
    const material = q(s, "MATERIAL_DIFFERS");
    raw.prepare("INSERT INTO clarification_replies (id, draft_id, sent_revision, reply_version_id, note, save_key, created_at) VALUES (?, ?, 1, ?, 'e-mail', ?, '2026-10-28T13:48:00.000Z')").run(linkId, s.draft.id, v2, randomUUID());
    const a1 = `ca_${randomUUID()}`;
    const a2 = `ca_${randomUUID()}`;
    const ins = raw.prepare("INSERT INTO clarification_answers (id, draft_id, reply_id, question_id, status, excerpt, confirmed_term, note, supersedes_id, idempotency_key, fingerprint, created_at) VALUES (?, ?, ?, ?, 'ANSWERED', ?, ?, NULL, ?, ?, ?, ?)");
    ins.run(a1, s.draft.id, linkId, material, EX_316, null, null, randomUUID(), "1".repeat(64), "2026-10-28T13:48:10.000Z");
    ins.run(a2, s.draft.id, linkId, material, EX_316, "316 at USD 4.80 per pcs", a1, randomUUID(), "2".repeat(64), "2026-10-28T13:48:20.000Z");
    const dump = (db: DatabaseSync) =>
      ["procurement_requests", "quote_series", "quote_versions", "quote_extraction_runs", "ai_budget_ledger", "sandbox_payment_records", "clarification_drafts", "clarification_draft_revisions"].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const beforeDump = dump(raw);
    raw.close();

    const backups: string[] = [];
    const db = openDatabase(w.path, { onBackup: (f) => backups.push(f) });
    assert.equal(SCHEMA_VERSION, 18);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.deepEqual(dump(db), beforeDump, "existing tables unchanged");
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1, "foreign keys back on");
    db.close();
    assert.match(backups[0], /\.v11-before-v18\./);
    assert.ok(existsSync(backups[0]));

    const w2 = world(w.path);
    const view = w2.replies.view(P, s.r.id, s.draft.id)!;
    assert.equal(view.seriesReplies.length, 1);
    const r = view.seriesReplies[0];
    assert.equal(r.source, "MIGRATED_FROM_QUOTE_VERSION");
    assert.equal(r.rawText, REPLY_1);
    assert.deepEqual(r.fromQuoteVersion, { id: v2, versionNumber: 2 });
    assert.match(r.id, /^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(view.links[0].id, linkId);
    assert.equal(view.links[0].note, "e-mail");
    const st = view.questions.find((x) => x.questionId === material)!;
    assert.deepEqual(st.history.map((h) => h.id), [a1, a2]);
    assert.equal(st.state, "STATEMENT_RECORDED");
    assert.equal(st.latest!.buyerStatement, "316 at USD 4.80 per pcs");
    assert.equal(st.latest!.basis, null);
    assert.equal(st.basisCurrent, false, "an unrecorded basis is never current");
    assert.deepEqual(st.basisChanges, ["BASIS_NOT_RECORDED"]);
    assert.equal(st.latest!.statementKind, null);
    assert.equal(st.quoteUpdate, "MANUAL_REVIEW", "an unclassified carried-over statement needs manual review");
    // The migrated file works: the history continues and the excerpt is checked against the copied text.
    const more = w2.replies.answer(P, s.r.id, s.draft.id, linkId, material, a2, { status: "PARTLY_ANSWERED", excerpt: EX_316 }, randomUUID());
    assert.equal(more.status, "SAVED");
  });

  test("a v12 file migrates to v13: one column added, existing answers unchanged and unclassified", async () => {
    const w = world();
    const s = await setup(w);
    const reply = saveReply(w, s);
    const link = linkReply(w, s, reply.id);
    const material = q(s, "MATERIAL_DIFFERS");
    const a = w.replies.answer(P, s.r.id, s.draft.id, link.id, material, null, { status: "ANSWERED", excerpt: EX_316, buyerStatement: "316", statementKind: "PROPOSES_NEW" }, randomUUID());
    assert.ok(a.status === "SAVED");
    for (const x of [w.ps, w.qs, w.es, w.bs, w.cs, w.rs]) x.close();
    const raw = new DatabaseSync(w.path);
    raw.exec("DROP TRIGGER clarification_answers_statement_kind; ALTER TABLE clarification_answers DROP COLUMN statement_kind; PRAGMA user_version = 12;");
    const rowsBefore = JSON.stringify(raw.prepare("SELECT * FROM clarification_answers ORDER BY rowid").all());
    raw.close();
    const backups: string[] = [];
    const db = openDatabase(w.path, { onBackup: (f) => backups.push(f) });
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    const rows = db.prepare("SELECT * FROM clarification_answers ORDER BY rowid").all() as Record<string, unknown>[];
    assert.equal(JSON.stringify(rows.map(({ statement_kind, ...rest }) => (assert.equal(statement_kind, null), rest))), rowsBefore);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
    assert.match(backups[0], /\.v12-before-v18\./);
    const w2 = world(w.path);
    assert.equal(w2.replies.view(P, s.r.id, s.draft.id)!.questions.find((x) => x.questionId === material)!.quoteUpdate, "MANUAL_REVIEW");
  });
});
