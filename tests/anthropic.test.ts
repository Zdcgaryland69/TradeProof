// Live Anthropic adapter, tested with a stubbed SDK surface: no network, no key, no spend.
// Run: npm test

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionRun } from "../src/lib/extraction.ts";
import { emptyInput } from "../src/lib/procurement.ts";
import { BudgetStore } from "../src/server/budget/store.ts";
import { ANTHROPIC_APPROVED_MODELS, AnthropicExtractionModel, type AnthropicMessagesApi } from "../src/server/extraction/anthropic.ts";
import { ModelCallError, resolveExtractionModel, type ResolvedModel } from "../src/server/extraction/model.ts";
import { ExtractionService } from "../src/server/extraction/service.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { validateProcurementInput } from "../src/server/procurement/validate.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { generousBudget } from "./helpers/budget.ts";
import { testBuyer } from "./helpers/principals.ts";

const FAKE_KEY = "test-not-a-real-key-0000"; // secret-scan: allow (fake value for tests)
const OUTPUT = { supplierQuoteNumbers: [], quoteDate: null, currency: null, items: [], total: null, incoterm: null, leadTime: null, paymentTerms: null, fees: [] };

function message(over: Partial<Omit<Anthropic.Message, "usage">> & { usage?: Partial<Anthropic.Usage> } = {}): Anthropic.Message & { _request_id: string } {
  const { usage, ...rest } = over;
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: JSON.stringify(OUTPUT), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    ...rest,
    usage: {
      input_tokens: 1500,
      output_tokens: 600,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: "global",
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
      speed: "standard",
      ...usage,
    },
    _request_id: "req_test_123",
  } as unknown as Anthropic.Message & { _request_id: string };
}

function stub(behaviour: { create?: () => Promise<Anthropic.Message>; count?: () => Promise<Anthropic.MessageTokensCount> } = {}) {
  const seen: { create: { body: Anthropic.MessageCreateParamsNonStreaming; options: unknown }[]; count: { body: Anthropic.MessageCountTokensParams; options: unknown }[] } = { create: [], count: [] };
  const api: AnthropicMessagesApi = {
    async create(body, options) {
      seen.create.push({ body, options });
      return behaviour.create ? behaviour.create() : message();
    },
    async countTokens(body, options) {
      seen.count.push({ body, options });
      return behaviour.count ? behaviour.count() : ({ input_tokens: 1400 } as Anthropic.MessageTokensCount);
    },
  };
  return { api, seen };
}

const REQ = { system: "sys", user: "user text", maxOutputTokens: 4000 };

describe("configuration", () => {
  test("anthropic + approved model → LIVE; the key value never appears in what the page or API can see", () => {
    const r = resolveExtractionModel({ AI_PROVIDER: "anthropic", AI_MODEL: "claude-sonnet-5-5", AI_API_KEY: FAKE_KEY });
    assert.equal(r.config.state, "READY");
    assert.deepEqual(r.config, { state: "READY", mode: "LIVE", provider: "anthropic", model: "claude-sonnet-5-5" });
    assert.ok(!JSON.stringify(r.config).includes(FAKE_KEY));
    assert.deepEqual([...ANTHROPIC_APPROVED_MODELS], ["claude-sonnet-5-5"]);
  });

  test("any other model (even another Claude model) is refused — no silent switch to another paid model", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5-20260101", "CLAUDE-SONNET-5-5"]) {
      const r = resolveExtractionModel({ AI_PROVIDER: "anthropic", AI_MODEL: m, AI_API_KEY: FAKE_KEY });
      assert.equal(r.config.state, "NOT_CONFIGURED", m);
      assert.equal(r.model, null);
    }
  });
});

describe("request shape", () => {
  test("one request: approved model, max_tokens 4000, thinking between_tools, effort high, no tools / cache / geo / fallbacks, SDK retries off", async () => {
    const { api, seen } = stub();
    const m = new AnthropicExtractionModel("claude-sonnet-5-5", FAKE_KEY, api);
    const signal = new AbortController().signal;
    await m.complete({ ...REQ, signal });
    assert.equal(seen.create.length, 1);
    const { body, options } = seen.create[0];
    assert.deepEqual(body, {
      model: "claude-sonnet-5-5",
      max_tokens: 4000,
      system: "sys",
      messages: [{ role: "user", content: "user text" }],
      thinking: { type: "between_tools" },
      output_config: { effort: "high" },
    });
    assert.equal((options as { maxRetries: number }).maxRetries, 0);
    assert.equal((options as { signal: AbortSignal }).signal, signal);
  });

  test("token count uses the same model, system, messages, thinking and effort; retries off", async () => {
    const { api, seen } = stub();
    const n = await new AnthropicExtractionModel("claude-sonnet-5-5", FAKE_KEY, api).countInputTokens(REQ);
    assert.equal(n, 1400);
    assert.deepEqual(seen.count[0].body, { model: "claude-sonnet-5-5", system: "sys", messages: [{ role: "user", content: "user text" }], thinking: { type: "between_tools" }, output_config: { effort: "high" } });
    assert.equal((seen.count[0].options as { maxRetries: number }).maxRetries, 0);
    assert.equal(seen.create.length, 0, "counting never creates a message");
  });
});

describe("reply mapping", () => {
  const run = (msg: Anthropic.Message) => new AnthropicExtractionModel("claude-sonnet-5-5", FAKE_KEY, stub({ create: async () => msg }).api).complete({ ...REQ, signal: new AbortController().signal });

  test("text, usage, stop reason and request id are reported as received", async () => {
    const r = await run(message());
    assert.equal(r.text, JSON.stringify(OUTPUT));
    assert.deepEqual([r.inputTokens, r.outputTokens, r.stopReason, r.requestId, r.truncated, r.billingNote], [1500, 600, "end_turn", "req_test_123", false, null]);
  });

  test("max_tokens → truncated; refusal → stop reason kept (no fallback model)", async () => {
    assert.equal((await run(message({ stop_reason: "max_tokens" }))).truncated, true);
    assert.equal((await run(message({ stop_reason: "refusal" }))).stopReason, "refusal");
  });

  test("usage that cannot be priced at the configured prices → billing note (budget keeps the reservation)", async () => {
    assert.match((await run(message({ usage: { cache_read_input_tokens: 10 } }))).billingNote ?? "", /cache/);
    assert.match((await run(message({ usage: { inference_geo: "us" } }))).billingNote ?? "", /inference region "us"/);
    assert.match((await run(message({ model: "claude-opus-5-5" } as Partial<Anthropic.Message>))).billingNote ?? "", /served by/);
  });
});

describe("errors: never retried; count errors are unbilled, call errors may have been billed", () => {
  const headers = new Headers();
  const cases: [string, () => Error, string][] = [
    ["401", () => Anthropic.APIError.generate(401, { error: { type: "authentication_error" } }, "bad key", headers), "AUTH"],
    ["429", () => Anthropic.APIError.generate(429, { error: { type: "rate_limit_error" } }, "slow down", headers), "RATE_LIMITED"],
    ["500", () => Anthropic.APIError.generate(500, { error: { type: "api_error" } }, "oops", headers), "SERVER_ERROR"],
    ["529", () => Anthropic.APIError.generate(529, { error: { type: "overloaded_error" } }, "busy", headers), "SERVER_ERROR"],
    ["connection", () => new Anthropic.APIConnectionError({ message: "reset" }), "NETWORK"],
    ["timeout", () => new Anthropic.APIConnectionTimeoutError(), "NETWORK"],
  ];
  for (const [name, make, code] of cases) {
    test(`${name} → ${code}, retryable false`, async () => {
      const call = new AnthropicExtractionModel("claude-sonnet-5-5", FAKE_KEY, stub({ create: async () => { throw make(); } }).api);
      const err = await call.complete({ ...REQ, signal: new AbortController().signal }).catch((e: unknown) => e);
      assert.ok(err instanceof ModelCallError);
      assert.deepEqual([err.code, err.retryable, err.notSent], [code, false, false]);
      assert.ok(!err.message.includes(FAKE_KEY));
      const count = new AnthropicExtractionModel("claude-sonnet-5-5", FAKE_KEY, stub({ count: async () => { throw make(); } }).api);
      const cerr = await count.countInputTokens(REQ).catch((e: unknown) => e);
      assert.ok(cerr instanceof ModelCallError);
      assert.equal(cerr.notSent, true, "counting generates nothing");
    });
  }
});

// ---------------------------------------------------------------- through the service, ledger and DB

let dir: string;
const open: { close(): void }[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-anthropic-"));
});
after(() => {
  for (const s of open) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function world(api: AnthropicMessagesApi) {
  const path = join(dir, `a-${randomUUID().slice(0, 8)}.sqlite`);
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const bs = new BudgetStore(path);
  open.push(ps, qs, es, bs);
  const model = new AnthropicExtractionModel("claude-sonnet-5-5", FAKE_KEY, api);
  const resolveModel = (): ResolvedModel => ({ config: { state: "READY", mode: "LIVE", provider: model.provider, model: model.model }, model }) as ResolvedModel;
  const svc = new ExtractionService(es, { resolveModel, nonce: () => "n", limits: { timeoutMs: 200, maxAttempts: 2, retryDelayMs: 1 }, budget: bs, resolveBudget: generousBudget() });
  const v = validateProcurementInput({ ...emptyInput(), buyerType: "BUSINESS", buyerCompany: "Co", title: "T", items: [{ id: null, name: "Bottle", quantity: "1", unit: "", material: "", specification: "", customization: "", notes: "" }] }, "create");
  assert.ok(v.ok);
  const record = ps.create(v.value, "USER_INPUT");
  const saved = qs.createSeries(record.id, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: 1,
    name: "Q",
    supplierDisplayName: null,
    version: { rawText: "Quotation No. QT-1\nTotal USD 10.00", contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: null, supplierQuoteDate: null, revisionNote: null },
  });
  assert.ok(saved.status === "CREATED");
  const P = testBuyer();
  const runOnce = async (key = randomUUID()) => {
    const o = await svc.run(P, record.id, saved.series.id, saved.version.id, { idempotencyKey: key, rerun: true });
    assert.equal(o.status, o.status === "REPLAYED" ? "REPLAYED" : "FINISHED", JSON.stringify(o).slice(0, 200));
    return (o as { run: ExtractionRun }).run;
  };
  return { path, bs, runOnce };
}

describe("service + ledger with the adapter", () => {
  test("success: reserved from the counted tokens, settled from usage with the request id; a repeat replays without a call", async () => {
    const s = stub();
    const w = world(s.api);
    const key = randomUUID();
    const r = await w.runOnce(key);
    assert.equal(r.status, "SUCCEEDED");
    assert.deepEqual([r.provider, r.model, r.mode], ["anthropic", "claude-sonnet-5-5", "LIVE"]);
    const [row] = w.bs.listForExtraction(r.id);
    assert.equal(row.state, "SETTLED");
    assert.equal(row.inputTokensBound, 1540 + 256, "1400 counted + 10 % + 256 (integer arithmetic)");
    assert.equal(row.outputTokensBound, 4000);
    assert.match(row.outcomeNote ?? "", /req_test_123/);
    assert.equal((await w.runOnce(key)).id, r.id);
    assert.equal(s.seen.create.length, 1);
  });

  test("token count fails → FAILED, nothing sent, no reservation", async () => {
    const s = stub({ count: async () => { throw new Anthropic.APIConnectionError({ message: "down" }); } });
    const w = world(s.api);
    const r = await w.runOnce();
    assert.deepEqual([r.status, r.errorCode, r.attempts], ["FAILED", "TOKEN_COUNT_FAILED", 0]);
    assert.equal(s.seen.create.length, 0);
    assert.deepEqual(w.bs.listForExtraction(r.id), []);
  });

  test("invalid JSON or a refusal: FAILED and honestly billed (settled), no repair call", async () => {
    const bad = stub({ create: async () => message({ content: [{ type: "text", text: "not json", citations: null }] }) });
    const w1 = world(bad.api);
    const r1 = await w1.runOnce();
    assert.deepEqual([r1.status, r1.errorCode], ["FAILED", "INVALID_OUTPUT"]);
    assert.equal(bad.seen.create.length, 1);
    assert.equal(w1.bs.listForExtraction(r1.id)[0].state, "SETTLED");
    const ref = stub({ create: async () => message({ stop_reason: "refusal" }) });
    const w2 = world(ref.api);
    const r2 = await w2.runOnce();
    assert.deepEqual([r2.status, r2.errorCode], ["FAILED", "REFUSED"]);
    assert.equal(ref.seen.create.length, 1);
    assert.equal(w2.bs.listForExtraction(r2.id)[0].state, "SETTLED");
  });

  test("network error, 529 and our own timeout: UNKNOWN (kept as spent), exactly one request each", async () => {
    for (const fail of [
      async () => { throw new Anthropic.APIConnectionError({ message: "reset" }); },
      async () => { throw Anthropic.APIError.generate(529, { error: { type: "overloaded_error" } }, "busy", new Headers()); },
      () => new Promise<Anthropic.Message>(() => {}),
    ]) {
      const s = stub({ create: fail as () => Promise<Anthropic.Message> });
      const w = world(s.api);
      const r = await w.runOnce();
      assert.equal(r.status, "FAILED");
      assert.equal(s.seen.create.length, 1);
      assert.deepEqual(w.bs.listForExtraction(r.id).map((x) => x.state), ["UNKNOWN"]);
    }
  });

  test("usage priced above the configured prices (US region) → UNKNOWN at the reservation; the key is stored nowhere", async () => {
    const s = stub({ create: async () => message({ usage: { inference_geo: "us" } }) });
    const w = world(s.api);
    const r = await w.runOnce();
    assert.equal(r.status, "SUCCEEDED");
    assert.equal(w.bs.listForExtraction(r.id)[0].state, "UNKNOWN");
    assert.ok(!readFileSync(w.path).includes(Buffer.from(FAKE_KEY)), "no key in the database file");
  });
});
