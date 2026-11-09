import { testBuyer, testGate } from "./helpers/principals.ts";
// Overall API budget for LIVE calls (schema v9). All models here are local fakes in temporary
// databases: nothing is sent anywhere and no real spend is recorded. Currency XTS = ISO test code.
// Run: npm test

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { Worker } from "node:worker_threads";
import { budgetDay, formatMicros } from "../src/lib/budget.ts";
import type { ExtractionRun } from "../src/lib/extraction.ts";
import { emptyInput, type ProcurementInput } from "../src/lib/procurement.ts";
import { BUDGET_ENV, boundMicros, costMicros, parseMicros, reservedInputTokens, resolveBudgetConfig, type BudgetConfigResult } from "../src/server/budget/config.ts";
import { BudgetStore, RESERVATION_STALE_MS } from "../src/server/budget/store.ts";
import { handleListExtractions, handleRunExtraction } from "../src/server/extraction/http.ts";
import { ModelCallError, type ExtractionModel, type ModelReply, type ModelRequest, type ResolvedModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore, STALE_RUNNING_MS } from "../src/server/extraction/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { generousBudget, testBudget } from "./helpers/budget.ts";

let dir: string;
let counter = 0;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-budget-"));
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
const file = () => join(dir, `b-${++counter}.sqlite`);

// ---------------------------------------------------------------- configuration

const FULL_ENV = {
  AI_BUDGET_APPROVED: "yes",
  AI_BUDGET_CURRENCY: "XTS",
  AI_BUDGET_TOTAL_LIMIT: "10.00",
  AI_BUDGET_DAILY_LIMIT: "2.50",
  AI_BUDGET_TOTAL_MAX_CALLS: "200",
  AI_BUDGET_DAILY_MAX_CALLS: "40",
  AI_PRICE_PROVIDER: "fake",
  AI_PRICE_MODEL: "fake-model",
  AI_PRICE_INPUT_PER_MTOK: "1.25",
  AI_PRICE_OUTPUT_PER_MTOK: "5",
  AI_PRICE_PER_REQUEST: "0",
};

describe("budget configuration", () => {
  test("nothing configured → refused, with variable names only", () => {
    const r = resolveBudgetConfig("fake", "fake-model", {});
    assert.equal(r.ok, false);
    assert.deepEqual((r as { missing: string[] }).missing, Object.values(BUDGET_ENV));
  });

  test("complete and approved → integer micro-units, exact", () => {
    const r = resolveBudgetConfig("fake", "fake-model", FULL_ENV);
    assert.ok(r.ok);
    assert.equal(r.config.limits.totalMicros, 10_000_000);
    assert.equal(r.config.limits.dailyMicros, 2_500_000);
    assert.equal(r.config.prices.inputPerMTokMicros, 1_250_000);
    assert.equal(parseMicros("0.000001"), 1);
    assert.equal(parseMicros("1e3"), null);
    assert.equal(parseMicros("-1"), null);
    assert.equal(parseMicros("1,000"), null);
  });

  test("not approved, unknown (zero) price, prices for another model, daily > total → refused; no value is echoed", () => {
    const cases: Record<string, string>[] = [
      { AI_BUDGET_APPROVED: "no" },
      { AI_PRICE_INPUT_PER_MTOK: "0" },
      { AI_PRICE_MODEL: "older-model" },
      { AI_PRICE_PROVIDER: "other" },
      { AI_BUDGET_DAILY_LIMIT: "20" },
      { AI_BUDGET_CURRENCY: "usd" },
    ];
    for (const over of cases) {
      const r = resolveBudgetConfig("fake", "fake-model", { ...FULL_ENV, ...over });
      assert.equal(r.ok, false, JSON.stringify(over));
      const text = JSON.stringify(r);
      for (const v of Object.values(over)) if (v.length > 2) assert.ok(!text.includes(`"${v}"`), `value ${v} must not be echoed`);
    }
  });

  test("cost bound: integer arithmetic, rounded up; input bound counts the whole prompt in UTF-8 bytes", () => {
    const prices = { inputPerMTokMicros: 1_250_000, outputPerMTokMicros: 5_000_000, perRequestMicros: 7 };
    assert.equal(costMicros(prices, 1, 1), 2 + 5 + 7, "1.25 → 2 and 5 micro-units, each rounded up");
    assert.equal(costMicros(prices, 1_000_000, 0), 1_250_007);
    assert.equal(reservedInputTokens(1000), 1100 + 256, "provider count + 10 % + 256");
    assert.equal(boundMicros(prices, 1_000_000, 0), Math.ceil((1_250_007 * 11) / 10), "1.1x headroom for a possible US-only workspace default");
    assert.equal(formatMicros(12_500_000), "12.50");
    assert.equal(formatMicros(315), "0.000315");
  });

  test("budget day is the Singapore calendar day (UTC+08:00)", () => {
    assert.equal(budgetDay(new Date("2026-10-25T15:59:59.999Z")), "2026-10-25");
    assert.equal(budgetDay(new Date("2026-10-25T16:00:00.000Z")), "2026-10-26");
  });
});

// ---------------------------------------------------------------- ledger

const res = (key: string, inputTokensBound = 1000, outputTokensBound = 1000) => ({ requestKey: key, extractionId: null, attempt: 1, inputTokensBound, outputTokensBound });

describe("budget ledger", () => {
  test("same request key never reserves twice; settling twice counts once", () => {
    const b = new BudgetStore(file());
    open.push(b);
    const cfg = testBudget();
    const first = b.reserve(cfg, res("k1"));
    assert.equal(first.status, "RESERVED");
    assert.equal(b.reserve(cfg, res("k1")).status, "DUPLICATE");
    const id = (first as { row: { id: string } }).row.id;
    assert.equal(b.settle(id, { inputTokens: 500, outputTokens: 100 }), true);
    assert.equal(b.settle(id, { inputTokens: 9_000, outputTokens: 9_000 }), false);
    assert.equal(b.markUnknown(id, "late"), false);
    const s = b.status({ ok: true, config: cfg });
    assert.ok(s.state === "CONFIGURED");
    assert.equal(s.total.calls, 1);
    assert.equal(s.total.settledMicros, costMicros(cfg.prices, 500, 100));
    assert.equal(s.total.pendingMicros, 0);
  });

  test("call and amount limits; released attempts are not counted; unknown ones keep their full reservation", () => {
    const b = new BudgetStore(file());
    open.push(b);
    const cfg = testBudget({ limits: { dailyCalls: 3, totalCalls: 3 } });
    const bound = boundMicros(cfg.prices, 1000, 1000);
    const a = b.reserve(cfg, res("a")) as { row: { id: string } };
    const c = b.reserve(cfg, res("c")) as { row: { id: string } };
    const d = b.reserve(cfg, res("d")) as { row: { id: string } };
    assert.deepEqual([b.reserve(cfg, res("e")).status], ["REFUSED"]);
    b.release(a.row.id, "not sent");
    b.markUnknown(c.row.id, "timeout");
    b.settle(d.row.id, { inputTokens: 10, outputTokens: 10 });
    const s = b.status({ ok: true, config: cfg });
    assert.ok(s.state === "CONFIGURED");
    assert.equal(s.total.calls, 2, "released is not a call");
    assert.equal(s.total.pendingMicros, bound, "unknown keeps the reserved upper bound");
    assert.equal(s.total.unknownCount, 1);
    assert.equal(b.reserve(cfg, res("f")).status, "RESERVED", "the released slot is free again");

    const small = testBudget({ limits: { dailyMicros: bound - 1, totalMicros: 1_000_000_000 } });
    const b2 = new BudgetStore(file());
    open.push(b2);
    const r = b2.reserve(small, res("x"));
    assert.equal(r.status, "REFUSED");
    assert.equal((r as { code: string }).code, "DAILY_AMOUNT");
  });

  test("restart: a reservation left without an outcome becomes UNKNOWN, stays counted and is never released", () => {
    const path = file();
    const t0 = new Date("2026-10-25T03:00:00Z");
    const b1 = new BudgetStore(path, { now: () => t0 });
    const cfg = testBudget();
    const r = b1.reserve(cfg, res("crash")) as { row: { id: string; reservedMicros: number } };
    b1.close(); // the process stops before the reply
    const later = new Date(t0.getTime() + RESERVATION_STALE_MS + 1);
    const b2 = new BudgetStore(path, { now: () => later });
    open.push(b2);
    const s = b2.status({ ok: true, config: cfg });
    assert.ok(s.state === "CONFIGURED");
    assert.equal(s.total.pendingMicros, r.row.reservedMicros);
    assert.equal(s.total.unknownCount, 1);
    assert.equal(b2.get(r.row.id)!.state, "UNKNOWN");
    assert.equal(b2.settle(r.row.id, { inputTokens: 1, outputTokens: 1 }), false, "no settlement after the fact");
    assert.equal(b2.reserve(cfg, res("crash")).status, "DUPLICATE", "the same attempt is never sent again");
  });

  test("day boundary resets the daily totals only; config, model or price changes never reset spend; another currency blocks", () => {
    const path = file();
    let now = new Date("2026-10-25T15:59:00Z"); // 23:59 SGT
    const b = new BudgetStore(path, { now: () => now });
    open.push(b);
    const cfg = testBudget({ limits: { dailyCalls: 1 } });
    const r1 = b.reserve(cfg, res("d1")) as { row: { id: string } };
    b.settle(r1.row.id, { inputTokens: 100, outputTokens: 100 });
    assert.equal(b.reserve(cfg, res("d2")).status, "REFUSED");
    now = new Date("2026-10-25T16:00:00Z"); // 00:00 SGT next day
    assert.equal(b.reserve(cfg, res("d3")).status, "RESERVED");
    const changed = testBudget({ model: "other-model", prices: { inputPerMTokMicros: 9_000_000, outputPerMTokMicros: 9_000_000, perRequestMicros: 0 } });
    const s = b.status({ ok: true, config: changed });
    assert.ok(s.state === "CONFIGURED");
    assert.equal(s.total.calls, 2, "a different model or price keeps the recorded total");
    const other = b.reserve(testBudget({ currency: "XXX" }), res("cur"));
    assert.equal(other.status, "REFUSED");
    assert.equal((other as { code: string }).code, "CURRENCY_MISMATCH");
    const notConfigured = b.status({ ok: false, missing: ["AI_BUDGET_APPROVED"], problems: [] });
    assert.ok(notConfigured.state === "NOT_CONFIGURED");
    assert.equal(notConfigured.recorded[0].total.calls, 2, "spend stays visible even with no budget configured");
  });

  test("closed rows cannot be changed or deleted", () => {
    const path = file();
    const b = new BudgetStore(path);
    open.push(b);
    const r = b.reserve(testBudget(), res("imm")) as { row: { id: string } };
    b.settle(r.row.id, { inputTokens: 1, outputTokens: 1 });
    const raw = new DatabaseSync(path);
    assert.throws(() => raw.prepare("UPDATE ai_budget_ledger SET settled_micros = 0").run(), /immutable/);
    assert.throws(() => raw.prepare("UPDATE ai_budget_ledger SET state = 'RELEASED'").run(), /immutable/);
    assert.throws(() => raw.prepare("DELETE FROM ai_budget_ledger").run(), /cannot be deleted/);
    raw.close();
  });
});

// ---------------------------------------------------------------- real concurrency (threads, one file)

async function race(
  path: string,
  threads: number,
  config: ReturnType<typeof testBudget>,
  inputTokensBound = 1000,
  opts: { openAfterBarrier?: boolean; key?: (i: number) => string } = {},
): Promise<string[]> {
  const shared = new SharedArrayBuffer(4);
  const flag = new Int32Array(shared);
  const key = opts.key ?? ((i: number) => `race-${i}`);
  const workers = Array.from(
    { length: threads },
    (_, i) => new Worker(new URL("./helpers/budget-worker.ts", import.meta.url), { workerData: { path, key: key(i), config, shared, inputTokensBound, openAfterBarrier: opts.openAfterBarrier ?? false } }),
  );
  const results = workers.map(
    (w) =>
      new Promise<{ ready: Promise<void>; done: Promise<string> }>((resolve) => {
        let readyResolve!: () => void;
        const ready = new Promise<void>((r) => (readyResolve = r));
        const done = new Promise<string>((r, reject) => {
          w.on("message", (m: string) => (m === "ready" ? readyResolve() : r(m)));
          w.on("error", reject);
        });
        resolve({ ready, done });
      }),
  );
  // Never leave threads running (they would keep the test process alive): terminate on success, error or timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("race timed out")), 20_000);
  });
  try {
    const handles = await Promise.all(results);
    await Promise.race([Promise.all(handles.map((h) => Promise.race([h.ready, h.done.then(() => undefined)]))), timeout]);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    return await Promise.race([Promise.all(handles.map((h) => h.done)), timeout]);
  } finally {
    clearTimeout(timer);
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

/** Raw ledger rows after a race: one row per reservation, never two for one request key. */
function ledgerRows(path: string): { rows: number; keys: number; ids: number } {
  const raw = new DatabaseSync(path, { readOnly: true });
  const r = raw.prepare("SELECT count(*) AS rows, count(DISTINCT request_key) AS keys, count(DISTINCT id) AS ids FROM ai_budget_ledger").get() as { rows: number; keys: number; ids: number };
  raw.close();
  return { rows: Number(r.rows), keys: Number(r.keys), ids: Number(r.ids) };
}

describe("concurrent reservations across threads and connections", () => {
  for (const openAfterBarrier of [false, true]) {
    const when = openAfterBarrier ? "open their connections at the same moment and " : "";
    test(`12 threads ${when}race for the last 3 calls: exactly 3 reserved, the rest refused`, async () => {
      const path = file();
      new BudgetStore(path).close(); // create and migrate once
      const out = await race(path, 12, testBudget({ limits: { dailyCalls: 3, totalCalls: 3 } }), 1000, { openAfterBarrier });
      assert.equal(out.filter((s) => s === "RESERVED").length, 3, out.join(","));
      assert.equal(out.filter((s) => s === "REFUSED:DAILY_CALLS" || s === "REFUSED:TOTAL_CALLS").length, 9, out.join(","));
      assert.deepEqual(ledgerRows(path), { rows: 3, keys: 3, ids: 3 });
      const check = new BudgetStore(path);
      open.push(check);
      const s = check.status({ ok: true, config: testBudget() });
      assert.ok(s.state === "CONFIGURED");
      assert.equal(s.total.calls, 3);
    });
  }

  test("12 threads open at the same moment with the same request key: one reservation, 11 duplicates", async () => {
    const path = file();
    new BudgetStore(path).close();
    const out = await race(path, 12, testBudget(), 1000, { openAfterBarrier: true, key: () => "run-1#1" });
    assert.equal(out.filter((s) => s === "RESERVED").length, 1, out.join(","));
    assert.equal(out.filter((s) => s === "DUPLICATE").length, 11, out.join(","));
    assert.deepEqual(ledgerRows(path), { rows: 1, keys: 1, ids: 1 });
  });

  test("10 threads race for an amount that covers exactly 2 upper bounds: the limit is never exceeded", async () => {
    const path = file();
    new BudgetStore(path).close();
    const cfg = testBudget();
    const bound = boundMicros(cfg.prices, 50_000, 1000);
    const tight = testBudget({ limits: { totalMicros: bound * 2 + bound - 1, dailyMicros: bound * 2 + bound - 1 } });
    const out = await race(path, 10, tight, 50_000);
    assert.equal(out.filter((s) => s === "RESERVED").length, 2, out.join(","));
    assert.deepEqual(ledgerRows(path), { rows: 2, keys: 2, ids: 2 });
    const check = new BudgetStore(path);
    open.push(check);
    const s = check.status({ ok: true, config: tight });
    assert.ok(s.state === "CONFIGURED");
    assert.ok(s.total.pendingMicros <= tight.limits.totalMicros);
  });
});

// ---------------------------------------------------------------- a lock held longer than the busy timeout

/** Another connection holding the write lock (as a long transaction elsewhere would). */
function holdWriteLock(path: string): () => void {
  const raw = new DatabaseSync(path);
  raw.exec("BEGIN IMMEDIATE");
  return () => {
    raw.exec("ROLLBACK");
    raw.close();
  };
}

describe("lock held longer than the busy timeout", () => {
  test("opening a database that still needs its schema fails loudly and writes nothing", () => {
    const path = file();
    new DatabaseSync(path).close(); // empty file, schema v0: opening must migrate (needs the write lock)
    const release = holdWriteLock(path);
    try {
      assert.throws(() => new BudgetStore(path, { busyTimeoutMs: 100 }), /database is locked/);
    } finally {
      release();
    }
    const b = new BudgetStore(path);
    open.push(b);
    assert.equal(ledgerRows(path).rows, 0);
  });

  test("a reservation that cannot get the lock throws — no row, no refusal disguised as success", () => {
    const path = file();
    const b = new BudgetStore(path, { busyTimeoutMs: 100 });
    open.push(b);
    const release = holdWriteLock(path);
    try {
      assert.throws(() => b.reserve(testBudget(), res("locked")), /database is locked/);
    } finally {
      release();
    }
    assert.equal(ledgerRows(path).rows, 0);
    assert.equal(b.reserve(testBudget(), res("locked")).status, "RESERVED", "the same key can be reserved once the lock is gone");
    assert.deepEqual(ledgerRows(path), { rows: 1, keys: 1, ids: 1 });
  });

  test("extraction: reservation locked out, lock gone before the run is finished → FAILED BUDGET_UNAVAILABLE, model never called", async () => {
    let release: (() => void) | null = null;
    const m = fakeModel(async () => okReply());
    // The lock is released as soon as the reservation has failed (a short lock elsewhere), so the run can be finished.
    const w = world(m, generousBudget(), {
      busyTimeoutMs: 100,
      makeLedger: (path, o) =>
        new (class extends BudgetStore {
          override reserve(...args: Parameters<BudgetStore["reserve"]>) {
            try {
              return super.reserve(...args);
            } finally {
              release?.();
              release = null;
            }
          }
        })(path, o),
    });
    const v = w.newVersion();
    // Take the lock after the run row exists and the tokens are counted, i.e. just before the reservation.
    m.countInputTokens = async () => {
      m.counts++;
      release = holdWriteLock(w.path);
      return 1000;
    };
    const r = finishedRun(await w.run(v));
    assert.equal(r.status, "FAILED");
    assert.equal(r.errorCode, "BUDGET_UNAVAILABLE");
    assert.equal(r.attempts, 0);
    assert.match(r.errorMessage ?? "", /database is locked/);
    assert.match(r.errorMessage ?? "", /Nothing was sent/);
    assert.equal(m.counts, 1);
    assert.equal(m.calls, 0, "no model request without a reservation");
    assert.equal(ledgerRows(w.path).rows, 0);
    // Not retried automatically; the version is not blocked: a new click starts a new run.
    m.countInputTokens = async () => (m.counts++, 1000);
    const again = finishedRun(await w.run(v));
    assert.notEqual(again.id, r.id);
    assert.equal(m.calls, 1);
    // Over HTTP the same situation is a 503 that says no model call was made.
    m.countInputTokens = async () => {
      m.counts++;
      release = holdWriteLock(w.path);
      return 1000;
    };
    const req = new Request(`http://127.0.0.1:3000/api/procurements/${v.requestId}/quotes/${v.seriesId}/versions/${v.versionId}/extractions`, {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID(), rerun: true }),
    });
    const res = await handleRunExtraction(req, v.requestId, v.seriesId, v.versionId, w.svc, { enabled: true, auth: testGate() });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "BUDGET_UNAVAILABLE");
    assert.match(body.message, /No model call was made/);
    assert.equal(m.calls, 1, "still only the one call from the unlocked run");
  });

  test("extraction: lock still held when the run would be finished → the error surfaces, the row stays RUNNING until recovery", async () => {
    let release: (() => void) | null = null;
    let clock = Date.parse("2026-10-26T08:00:00.000Z");
    const m = fakeModel(async () => okReply());
    const w = world(m, generousBudget(), { busyTimeoutMs: 100, now: () => new Date(clock) });
    const v = w.newVersion();
    m.countInputTokens = async () => {
      m.counts++;
      release = holdWriteLock(w.path);
      return 1000;
    };
    try {
      // The reservation fails (BUDGET_UNAVAILABLE), then writing the FAILED status fails too: reported, not claimed as saved.
      await assert.rejects(w.run(v), /database is locked/);
    } finally {
      (release as (() => void) | null)?.();
    }
    assert.equal(m.calls, 0, "no model request without a reservation");
    assert.equal(ledgerRows(w.path).rows, 0);
    assert.deepEqual(w.es.listRuns(v.versionId).map((r) => r.status), ["RUNNING"]);
    // Recovery (existing): the next start after STALE_RUNNING_MS closes it as FAILED / INTERRUPTED (outcome unknown).
    clock += STALE_RUNNING_MS + 1000;
    m.countInputTokens = async () => (m.counts++, 1000);
    finishedRun(await w.run(v));
    const runs = w.es.listRuns(v.versionId);
    const old = runs.find((r) => r.attempts === 0 && r.status === "FAILED");
    assert.equal(old?.errorCode, "INTERRUPTED");
    assert.equal(runs.filter((r) => r.status === "RUNNING").length, 0);
  });
});

// ---------------------------------------------------------------- through the extraction service

const TEXT = "Quotation No. QT-9\n1) Bottle — 300 pcs @ USD 3.20 = USD 960.00\nTotal: USD 960.00";

function normalized(body: unknown) {
  const r = validateProcurementInput(body, "create");
  assert.ok(r.ok);
  return r.value;
}

function fakeModel(behaviour: (call: number, req: ModelRequest) => Promise<ModelReply>, mode: "LIVE" | "MOCK" = "LIVE"): ExtractionModel & { calls: number; counts: number } {
  const m = {
    mode,
    provider: "fake",
    model: "fake-model",
    calls: 0,
    counts: 0,
    async complete(req: ModelRequest) {
      m.calls++;
      return behaviour(m.calls, req);
    },
    // Stands in for the provider's token count (free, generates nothing).
    async countInputTokens() {
      m.counts++;
      return 1000;
    },
  };
  return m;
}

const okReply = (usage = true): ModelReply => ({
  text: JSON.stringify({ supplierQuoteNumbers: [], quoteDate: null, currency: null, items: [], total: null, incoterm: null, leadTime: null, paymentTerms: null, fees: [] }),
  truncated: false,
  inputTokens: usage ? 1200 : null,
  outputTokens: usage ? 300 : null,
});

function world(
  model: ExtractionModel,
  resolveBudget: (p: string, m: string) => BudgetConfigResult,
  opts: { ledger?: boolean; now?: () => Date; busyTimeoutMs?: number; makeLedger?: (path: string, o: ConstructorParameters<typeof BudgetStore>[1]) => BudgetStore } = {},
) {
  const path = file();
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path, { now: opts.now, busyTimeoutMs: opts.busyTimeoutMs });
  const ledgerOpts = { now: opts.now, busyTimeoutMs: opts.busyTimeoutMs };
  const bs = opts.makeLedger ? opts.makeLedger(path, ledgerOpts) : new BudgetStore(path, ledgerOpts);
  open.push(ps, qs, es, bs);
  const input: ProcurementInput = { ...emptyInput(), buyerType: "BUSINESS", buyerCompany: "Test Co", title: "Bottles", items: [{ id: null, name: "Bottle", quantity: "300", unit: "pcs", material: "", specification: "", customization: "", notes: "" }] };
  const resolveModel = (): ResolvedModel => ({ config: { state: "READY", mode: model.mode, provider: model.provider, model: model.model }, model }) as ResolvedModel;
  const svc = new ExtractionService(es, { resolveModel, nonce: () => "n", limits: { timeoutMs: 100, maxAttempts: 2, retryDelayMs: 1 }, budget: opts.ledger === false ? null : bs, resolveBudget });
  const newVersion = () => {
    const record = ps.create(normalized({ ...input, title: `Bottles ${randomUUID().slice(0, 4)}` }), "USER_INPUT");
    const saved = qs.createSeries(record.id, {
      idempotencyKey: randomUUID(),
      expectedRequestRevision: 1,
      name: "Q",
      supplierDisplayName: null,
      version: { rawText: TEXT, contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
    });
    assert.ok(saved.status === "CREATED");
    return { requestId: record.id, seriesId: saved.series.id, versionId: saved.version.id };
  };
  const P = testBuyer();
  const run = (v: ReturnType<typeof newVersion>, key = randomUUID()) => svc.run(P, v.requestId, v.seriesId, v.versionId, { idempotencyKey: key, rerun: false });
  return { path, es, bs, svc, newVersion, run };
}

const finishedRun = (o: Awaited<ReturnType<ExtractionService["run"]>>): ExtractionRun => {
  assert.equal(o.status, "FINISHED", JSON.stringify(o).slice(0, 300));
  return (o as { run: ExtractionRun }).run;
};

describe("extraction runs and the budget", () => {
  test("budget not configured or no ledger → refused before any run row or call", async () => {
    const m = fakeModel(async () => okReply());
    const w = world(m, () => ({ ok: false, missing: ["AI_BUDGET_APPROVED"], problems: ["not configured"] }));
    const v = w.newVersion();
    assert.equal((await w.run(v)).status, "BUDGET_NOT_CONFIGURED");
    const w2 = world(m, generousBudget(), { ledger: false });
    const v2 = w2.newVersion();
    assert.equal((await w2.run(v2)).status, "BUDGET_NOT_CONFIGURED");
    assert.equal(m.calls, 0);
    assert.deepEqual(w.es.listRuns(v.versionId), []);
  });

  test("MOCK runs need no budget and never write to the LIVE ledger", async () => {
    const m = fakeModel(async () => okReply(), "MOCK");
    const w = world(m, () => ({ ok: false, missing: ["AI_BUDGET_APPROVED"], problems: [] }));
    const r = finishedRun(await w.run(w.newVersion()));
    assert.equal(r.mode, "MOCK");
    assert.deepEqual(w.bs.listForExtraction(r.id), []);
  });

  test("success: one reservation settled from reported usage; a repeat of the same click neither reserves nor calls again", async () => {
    const m = fakeModel(async () => okReply());
    const w = world(m, generousBudget());
    const v = w.newVersion();
    const key = randomUUID();
    const r = finishedRun(await w.run(v, key));
    const rows = w.bs.listForExtraction(r.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "SETTLED");
    assert.equal(rows[0].settledMicros, costMicros(testBudget().prices, 1200, 300));
    assert.ok(rows[0].reservedMicros >= rows[0].settledMicros!, "the bound covers the actual usage");
    assert.ok(rows[0].inputTokensBound > Buffer.byteLength(TEXT), "the bound covers the whole prompt, not only the quote text");
    assert.equal((await w.run(v, key)).status, "REPLAYED");
    assert.equal(m.calls, 1);
    assert.equal(w.bs.listForExtraction(r.id).length, 1);
  });

  test("timeout and reply without usage → UNKNOWN at the full reservation (never free, never an invented exact cost)", async () => {
    const slow = fakeModel(() => new Promise((resolve) => setTimeout(() => resolve(okReply()), 500)));
    const w = world(slow, generousBudget());
    const r = finishedRun(await w.run(w.newVersion()));
    assert.equal(r.errorCode, "TIMEOUT");
    const [row] = w.bs.listForExtraction(r.id);
    assert.equal(row.state, "UNKNOWN");
    assert.equal(row.settledMicros, null);
    assert.equal(slow.calls, 1, "a timeout is not retried");

    const noUsage = fakeModel(async () => okReply(false));
    const w2 = world(noUsage, generousBudget());
    const r2 = finishedRun(await w2.run(w2.newVersion()));
    assert.equal(w2.bs.listForExtraction(r2.id)[0].state, "UNKNOWN");
    const s = w2.bs.status(generousBudget()("fake", "fake-model"));
    assert.ok(s.state === "CONFIGURED");
    assert.equal(s.total.pendingMicros, w2.bs.listForExtraction(r2.id)[0].reservedMicros);
  });

  test("a retried attempt needs its own reservation; an error that may have been processed stays UNKNOWN; a definite not-sent is released", async () => {
    const flaky = fakeModel(async (call) => {
      if (call === 1) throw new ModelCallError("SERVER_ERROR", true, "503");
      return okReply();
    });
    const w = world(flaky, generousBudget());
    const r = finishedRun(await w.run(w.newVersion()));
    assert.deepEqual(w.bs.listForExtraction(r.id).map((x) => [x.attempt, x.state]), [[1, "UNKNOWN"], [2, "SETTLED"]]);

    const local = fakeModel(async () => {
      throw new ModelCallError("NETWORK", false, "refused before connecting", true);
    });
    const w2 = world(local, generousBudget());
    const r2 = finishedRun(await w2.run(w2.newVersion()));
    assert.deepEqual(w2.bs.listForExtraction(r2.id).map((x) => x.state), ["RELEASED"]);
  });

  test("the overall limit spans requests and versions; a refused run makes no call and does not use the per-version cap", async () => {
    const m = fakeModel(async () => okReply());
    const w = world(m, generousBudget({ limits: { dailyCalls: 2, totalCalls: 2 } }));
    finishedRun(await w.run(w.newVersion()));
    finishedRun(await w.run(w.newVersion()));
    const third = w.newVersion();
    const r = finishedRun(await w.run(third));
    assert.equal(r.status, "FAILED");
    assert.equal(r.errorCode, "BUDGET_EXHAUSTED");
    assert.equal(r.attempts, 0);
    assert.equal(m.calls, 2);
    assert.deepEqual(w.bs.listForExtraction(r.id), []);
  });

  test("a retry the budget cannot cover is not sent; the first error is reported", async () => {
    const flaky = fakeModel(async () => {
      throw new ModelCallError("RATE_LIMITED", true, "429");
    });
    const w = world(flaky, generousBudget({ limits: { dailyCalls: 1, totalCalls: 1 } }));
    const r = finishedRun(await w.run(w.newVersion()));
    assert.equal(r.errorCode, "RATE_LIMITED");
    assert.match(r.errorMessage ?? "", /Retry not sent/);
    assert.equal(flaky.calls, 1);
  });

  test("HTTP: 503 BUDGET_NOT_CONFIGURED; 429 BUDGET_EXHAUSTED; the read shows the budget; production → 404", async () => {
    const m = fakeModel(async () => okReply());
    const local = { enabled: true, auth: testGate() };
    const post = (v: { requestId: string; seriesId: string; versionId: string }) =>
      new Request(`http://127.0.0.1:3000/api/procurements/${v.requestId}/quotes/${v.seriesId}/versions/${v.versionId}/extractions`, {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      });
    const w = world(m, () => ({ ok: false, missing: ["AI_BUDGET_APPROVED"], problems: ["No budget."] }));
    const v = w.newVersion();
    const res503 = await handleRunExtraction(post(v), v.requestId, v.seriesId, v.versionId, w.svc, local);
    assert.equal(res503.status, 503);
    assert.equal((await res503.json()).code, "BUDGET_NOT_CONFIGURED");

    const w2 = world(m, generousBudget({ limits: { dailyCalls: 1, totalCalls: 1 } }));
    const a = w2.newVersion();
    assert.equal((await handleRunExtraction(post(a), a.requestId, a.seriesId, a.versionId, w2.svc, local)).status, 201);
    const b = w2.newVersion();
    const res429 = await handleRunExtraction(post(b), b.requestId, b.seriesId, b.versionId, w2.svc, local);
    assert.equal(res429.status, 429);
    assert.equal((await res429.json()).code, "BUDGET_EXHAUSTED");
    assert.equal(m.calls, 1);

    const get = new Request(`http://127.0.0.1:3000/api/procurements/${a.requestId}/quotes/${a.seriesId}/versions/${a.versionId}/extractions`, { headers: { host: "127.0.0.1:3000" } });
    const listed = await (await handleListExtractions(get, a.requestId, a.seriesId, a.versionId, w2.svc, local)).json();
    // 30 Oct: the read shows only whether a real call could start (the ledger is global; no totals, limits or configuration).
    assert.deepEqual(listed.budget, { state: "UNAVAILABLE", reason: "TOTAL_LIMIT_REACHED" });
    assert.equal(Object.values(listed.costs as Record<string, unknown[]>).flat().length, 1);

    assert.equal((await handleRunExtraction(post(a), a.requestId, a.seriesId, a.versionId, w2.svc, { enabled: false, auth: testGate() })).status, 404);
    const foreign = new Request(post(a), { headers: { host: "evil.example", origin: "http://evil.example", "content-type": "application/json" } });
    assert.equal((await handleRunExtraction(foreign, a.requestId, a.seriesId, a.versionId, w2.svc, local)).status, 403);
  });
});
