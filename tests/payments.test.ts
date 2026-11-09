// Automated tests for the Sandbox payment module using the MOCK PayPal gateway (simulated responses).
// These do NOT prove anything about the real PayPal Sandbox; see docs/payment-validation.md.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { publicConfig, readPayPalConfig } from "../src/server/payments/config.ts";
import { serverTime } from "../src/server/payments/paypal-gateway.ts";
import { handleCapture, handleCreateOrder, handleCreateRecord, handleGetRecord, handleReconcile } from "../src/server/payments/http.ts";
import { formatMinorUnits, toMinorUnits } from "../src/server/payments/money.ts";
import { AUTO_RETRY_WINDOW_MS, PAYPAL_IDEMPOTENCY_RETENTION_MS, PaymentService } from "../src/server/payments/service.ts";
import { PaymentStore } from "../src/server/payments/store.ts";
import { GatewayError } from "../src/server/payments/types.ts";
import { MOCK_PAYEE, MockPayPal } from "./mock-paypal.ts";

let dir: string;
let dbCounter = 0;
const openStores: PaymentStore[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tradeproof-payments-test-"));
});
after(() => {
  // Windows cannot delete SQLite files that are still open.
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function newDbPath(): string {
  return join(dir, `payments-${++dbCounter}.sqlite`);
}

interface Harness {
  store: PaymentStore;
  paypal: MockPayPal;
  service: PaymentService;
  dbPath: string;
}

function harness(options: { dbPath?: string; paypal?: MockPayPal; payee?: string | null; now?: () => Date; configured?: boolean } = {}): Harness {
  const dbPath = options.dbPath ?? newDbPath();
  const store = new PaymentStore(dbPath);
  openStores.push(store);
  const paypal = options.paypal ?? new MockPayPal();
  const service = new PaymentService({
    store,
    gateway: options.configured === false ? null : paypal,
    payeeMerchantId: options.payee === undefined ? MOCK_PAYEE : options.payee,
    now: options.now,
  });
  return { store, paypal, service, dbPath };
}

/** Record + PayPal order + simulated buyer approval. */
async function approvedRecord(h: Harness): Promise<string> {
  const rec = h.service.createTestRecord().record!;
  const created = await h.service.createPayPalOrder(rec.id);
  assert.equal(created.code, "ORDER_READY");
  h.paypal.approve(created.orderId!);
  return rec.id;
}

const LOCAL = "http://127.0.0.1:3000";
const OPTS = { enabled: true };
function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${LOCAL}${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin: LOCAL, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("money (exact minor units)", () => {
  test("parses PayPal decimal strings without floating point", () => {
    assert.equal(toMinorUnits("1.00", "USD"), 100);
    assert.equal(toMinorUnits("1", "USD"), 100);
    assert.equal(toMinorUnits("0.1", "USD"), 10);
    assert.equal(toMinorUnits("1.000", "USD"), 100);
    assert.equal(toMinorUnits("1.001", "USD"), null);
    assert.equal(toMinorUnits("1e2", "USD"), null);
    assert.equal(toMinorUnits("-1.00", "USD"), null);
    assert.equal(toMinorUnits("1.00", "XYZ"), null);
    assert.equal(formatMinorUnits(100, "USD"), "1.00");
    assert.equal(formatMinorUnits(5, "USD"), "0.05");
  });
});

describe("config (Sandbox enforced, secrets never public)", () => {
  const full = {
    PAYPAL_ENVIRONMENT: "sandbox",
    PAYPAL_CLIENT_ID: "test-client-id",
    PAYPAL_CLIENT_SECRET: "FAKE-test-secret-do-not-leak", // secret-scan: allow (fake value; test proves it is never exposed)
    PAYPAL_EXPECTED_PAYEE_MERCHANT_ID: "ABCDEFGHJKLMN",
  };
  test("missing values → not configured, names only", () => {
    const cfg = readPayPalConfig({ PAYPAL_ENVIRONMENT: "sandbox" });
    assert.equal(cfg.configured, false);
    assert.deepEqual(!cfg.configured && cfg.missing, ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_EXPECTED_PAYEE_MERCHANT_ID"]);
  });
  test("live environment or live API base is refused", () => {
    assert.equal(readPayPalConfig({ ...full, PAYPAL_ENVIRONMENT: "live" }).configured, false);
    assert.equal(readPayPalConfig({ ...full, PAYPAL_API_BASE: "https://api-m.paypal.com" }).configured, false);
    assert.equal(readPayPalConfig({ ...full, PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com" }).configured, true);
  });
  test("public config never contains the secret", () => {
    const view = JSON.stringify(publicConfig(readPayPalConfig(full)));
    assert.ok(!view.includes(full.PAYPAL_CLIENT_SECRET));
    assert.ok(view.includes("test-client-id"));
  });
});

describe("happy path (MOCK)", () => {
  test("create → approve → capture → GET verification → PAID", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    const result = await h.service.capture(id);
    assert.equal(result.code, "PAID");
    const rec = h.service.getRecord(id)!;
    assert.equal(rec.status, "PAID");
    assert.match(rec.paypalCaptureId!, /^MOCKCAPTURE/);
    assert.ok(rec.paidAt);
    assert.equal(h.paypal.calls.create.length, 1);
    assert.equal(h.paypal.calls.capture.length, 1);
    // create and capture use different, persisted request ids
    assert.equal(h.paypal.calls.create[0].requestId, rec.createRequestId);
    assert.equal(h.paypal.calls.capture[0].requestId, rec.captureRequestId);
    assert.notEqual(rec.createRequestId, rec.captureRequestId);
    // post-capture verification used an independent GET
    assert.ok(h.paypal.calls.get.length >= 2);
    assert.deepEqual(
      h.service.events(id).map((e) => e.type),
      ["RECORD_CREATED", "CREATE_ATTEMPT", "ORDER_CREATED", "CAPTURE_ATTEMPT", "CAPTURE_RESPONSE", "VERIFIED_PAID"],
    );
  });
});

describe("client tampering is ignored", () => {
  test("amount/currency in request bodies cannot change what PayPal is asked for", async () => {
    const h = harness();
    const createRes = await handleCreateRecord(post("/api/sandbox-demo/records", { amountMinor: 1, currency: "JPY", amount: "0.01" }), h.service, OPTS);
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { record: { id: string; amountMinor: number; currency: string } };
    assert.equal(created.record.amountMinor, 100);
    assert.equal(created.record.currency, "USD");

    const id = created.record.id;
    const orderRes = await handleCreateOrder(post(`/api/sandbox-demo/records/${id}/order`, { amount: "0.01", currency: "JPY", value: "0.01" }), id, h.service, OPTS);
    assert.equal(orderRes.status, 200);
    assert.deepEqual(h.paypal.calls.create[0].input.amount, { currencyCode: "USD", value: "1.00" });
  });
});

describe("orders not linked to the local record cannot be captured", () => {
  test("client-supplied order id that is not this record's → refused, nothing captured", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    h.paypal.addForeignOrder("FOREIGNORDER0001");
    const res = await handleCapture(post(`/api/sandbox-demo/records/${id}/capture`, { orderId: "FOREIGNORDER0001" }), id, h.service, OPTS);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "ORDER_MISMATCH");
    assert.equal(h.paypal.calls.capture.length, 0);
    assert.equal(h.service.getRecord(id)!.status, "ORDER_CREATED");
  });

  test("unknown local record / malformed ids → 404 or 400, nothing captured", async () => {
    const h = harness();
    const unknown = "tp_00000000-0000-4000-8000-000000000000";
    assert.equal((await handleCapture(post(`/x/${unknown}/capture`, {}), unknown, h.service, OPTS)).status, 404);
    assert.equal((await handleCapture(post("/x/../capture", {}), "../etc", h.service, OPTS)).status, 404);
    const id = await approvedRecord(h);
    assert.equal((await handleCapture(post("/x", { orderId: "x'; DROP TABLE" }), id, h.service, OPTS)).status, 400);
    assert.equal(h.paypal.calls.capture.length, 0);
  });

  test("stored order that PayPal reports as belonging to something else → NEEDS_REVIEW, not captured", async () => {
    const h = harness();
    const rec = h.service.createTestRecord().record!;
    h.paypal.addForeignOrder("FOREIGNORDER0002");
    // Simulate a corrupted / wrong link in the local DB.
    h.store.transition(rec.id, { from: ["NEW"] }, { status: "ORDER_CREATED", paypalOrderId: "FOREIGNORDER0002" }, new Date().toISOString());
    const result = await h.service.capture(rec.id);
    assert.equal(result.code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.capture.length, 0);
    assert.ok(h.service.getRecord(rec.id)!.reviewReasons.some((r) => r.includes("reference_id")));
  });
});

describe("duplicate and concurrent requests", () => {
  test("repeated create returns the same PayPal order", async () => {
    const h = harness();
    const rec = h.service.createTestRecord().record!;
    const a = await h.service.createPayPalOrder(rec.id);
    const b = await h.service.createPayPalOrder(rec.id);
    assert.equal(a.orderId, b.orderId);
    assert.equal(h.paypal.calls.create.length, 1);
  });

  test("concurrent creates → one PayPal create call", async () => {
    const h = harness();
    h.paypal.createDelayMs = 30;
    const rec = h.service.createTestRecord().record!;
    const results = await Promise.all(Array.from({ length: 6 }, () => h.service.createPayPalOrder(rec.id)));
    assert.equal(h.paypal.calls.create.length, 1);
    assert.equal(results.filter((r) => r.code === "ORDER_READY").length, 1);
    assert.ok(results.every((r) => r.code === "ORDER_READY" || r.code === "IN_PROGRESS"));
  });

  test("repeated capture (click again / refresh) → no second capture", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    assert.equal((await h.service.capture(id)).code, "PAID");
    const again = await h.service.capture(id);
    assert.equal(again.code, "ALREADY_PAID");
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.equal(h.paypal.totalCaptures(), 1);
  });

  test("concurrent captures in one process → exactly one PayPal capture", async () => {
    const h = harness();
    h.paypal.captureDelayMs = 40;
    const id = await approvedRecord(h);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.service.capture(id)));
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.equal(h.paypal.totalCaptures(), 1);
    assert.equal(results.filter((r) => r.code === "PAID").length, 1);
    assert.ok(results.every((r) => ["PAID", "IN_PROGRESS", "ALREADY_PAID"].includes(r.code)));
    assert.equal(h.service.getRecord(id)!.status, "PAID");
  });

  test("concurrent captures from two DB connections (two processes) → exactly one capture", async () => {
    const paypal = new MockPayPal();
    paypal.captureDelayMs = 40;
    const a = harness({ paypal });
    const b = harness({ paypal, dbPath: a.dbPath });
    const id = await approvedRecord(a);
    const results = await Promise.all([a.service.capture(id), b.service.capture(id), a.service.capture(id), b.service.capture(id)]);
    assert.equal(paypal.calls.capture.length, 1);
    assert.equal(results.filter((r) => r.code === "PAID").length, 1);
    assert.equal(b.service.getRecord(id)!.status, "PAID");
  });
});

describe("mismatched PayPal data is never marked PAID", () => {
  const cases: [string, (h: Harness) => void][] = [
    ["captured amount differs", (h) => (h.paypal.tamperGet = (o) => { if (o.status === "COMPLETED") o.purchaseUnits[0].captures[0].amount = { currencyCode: "USD", value: "2.00" }; })],
    ["captured currency differs", (h) => (h.paypal.tamperGet = (o) => { if (o.status === "COMPLETED") o.purchaseUnits[0].captures[0].amount = { currencyCode: "EUR", value: "1.00" }; })],
    ["order amount differs", (h) => (h.paypal.tamperGet = (o) => { o.purchaseUnits[0].amount = { currencyCode: "USD", value: "0.99" }; })],
    ["payee differs (wrong supplier)", (h) => (h.paypal.payeeMerchantId = "OTHERMERCHANT")],
    ["second capture appears on the order", (h) => (h.paypal.tamperGet = (o) => { if (o.status === "COMPLETED") o.purchaseUnits[0].captures.push({ id: "EXTRA", status: "COMPLETED", amount: { currencyCode: "USD", value: "1.00" } }); })],
  ];
  for (const [name, setup] of cases) {
    test(name, async () => {
      const h = harness();
      setup(h);
      const id = await approvedRecord(h);
      const result = await h.service.capture(id);
      assert.equal(result.code, "NEEDS_REVIEW", JSON.stringify(result.problems));
      const rec = h.service.getRecord(id)!;
      assert.equal(rec.status, "NEEDS_REVIEW");
      assert.equal(rec.paidAt, null);
      assert.ok(rec.reviewReasons.length > 0);
      // A reviewed record is not captured or changed by further clicks.
      const before = h.paypal.calls.capture.length;
      assert.equal((await h.service.capture(id)).code, "INVALID_STATE");
      assert.equal(h.paypal.calls.capture.length, before);
    });
  }

  test("PENDING capture → CAPTURE_PENDING, not PAID", async () => {
    const h = harness();
    h.paypal.captureStatus = "PENDING";
    const id = await approvedRecord(h);
    assert.equal((await h.service.capture(id)).code, "CAPTURE_PENDING");
    assert.equal(h.service.getRecord(id)!.status, "CAPTURE_PENDING");
  });
});

describe("unknown capture outcome is kept for reconciliation", () => {
  test("timeout before PayPal processed + lookup fails → CAPTURE_UNKNOWN; reconcile reuses the SAME capture request id", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    h.paypal.captureFaults = ["timeout-before-processing"];
    // fail the immediate post-timeout lookup as well
    const originalGet = h.paypal.getOrder.bind(h.paypal);
    let failNextGetAfterCapture = true;
    h.paypal.getOrder = async (orderId) => {
      if (failNextGetAfterCapture && h.paypal.calls.capture.length === 1) {
        failNextGetAfterCapture = false;
        h.paypal.calls.get.push(orderId);
        throw new GatewayError("MOCK lookup timeout", "uncertain");
      }
      return originalGet(orderId);
    };
    const first = await h.service.capture(id);
    assert.equal(first.code, "CAPTURE_UNKNOWN");
    const pending = h.service.getRecord(id)!;
    assert.equal(pending.status, "CAPTURE_UNKNOWN");
    assert.equal(pending.paidAt, null);

    const reconciled = await h.service.reconcile(id);
    assert.equal(reconciled.code, "PAID");
    assert.equal(h.paypal.calls.capture.length, 2);
    assert.equal(h.paypal.calls.capture[0].requestId, h.paypal.calls.capture[1].requestId);
    assert.equal(h.paypal.calls.create.length, 1, "no new order created");
    assert.equal(h.paypal.totalCaptures(), 1);
  });

  test("PayPal captured but response lost → immediate lookup finds it → PAID with one capture", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    h.paypal.captureFaults = ["timeout-after-processing"];
    const result = await h.service.capture(id);
    assert.equal(result.code, "PAID");
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.equal(h.paypal.totalCaptures(), 1);
  });

  test("response lost and PayPal unreachable → stays CAPTURE_UNKNOWN (not unpaid, not paid)", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    h.paypal.captureFaults = ["timeout-after-processing"];
    h.paypal.getFailures = 1;
    // the pre-capture GET must succeed, so make the failure apply to the post-capture GET
    const getBefore = h.paypal.getOrder.bind(h.paypal);
    let calls = 0;
    h.paypal.getOrder = async (orderId) => {
      calls++;
      if (calls === 1) {
        h.paypal.getFailures = 0;
        const order = await getBefore(orderId);
        h.paypal.getFailures = 1;
        return order;
      }
      return getBefore(orderId);
    };
    assert.equal((await h.service.capture(id)).code, "CAPTURE_UNKNOWN");
    assert.equal(h.service.getRecord(id)!.status, "CAPTURE_UNKNOWN");
    // Clicking capture again goes through reconciliation, which finds the existing capture.
    assert.equal((await h.service.capture(id)).code, "PAID");
    assert.equal(h.paypal.totalCaptures(), 1);
    assert.equal(h.paypal.calls.capture.length, 1);
  });

  test("buyer closed the window before approving → NOT_APPROVED, record unchanged", async () => {
    const h = harness();
    const rec = h.service.createTestRecord().record!;
    await h.service.createPayPalOrder(rec.id);
    assert.equal((await h.service.reconcile(rec.id)).code, "NOT_APPROVED");
    assert.equal(h.service.getRecord(rec.id)!.status, "ORDER_CREATED");
    assert.equal(h.paypal.calls.capture.length, 0);
  });

  test("buyer approved but the browser never called capture → reconcile captures once", async () => {
    const h = harness();
    const id = await approvedRecord(h);
    assert.equal((await h.service.reconcile(id)).code, "PAID");
    assert.equal(h.paypal.totalCaptures(), 1);
  });
});

describe("restart recovery (records persisted in SQLite)", () => {
  test("PAID record survives restart; capture after restart does not capture again", async () => {
    const paypal = new MockPayPal();
    const first = harness({ paypal });
    const id = await approvedRecord(first);
    assert.equal((await first.service.capture(id)).code, "PAID");
    const paidBefore = first.service.getRecord(id)!;
    first.store.close();

    const second = harness({ paypal, dbPath: first.dbPath });
    const reloaded = second.service.getRecord(id)!;
    assert.deepEqual(reloaded, paidBefore);
    assert.equal((await second.service.capture(id)).code, "ALREADY_PAID");
    assert.equal(paypal.calls.capture.length, 1);
    assert.equal(second.service.listRecords().length, 1);
  });

  test("crash mid-capture: after restart and lease expiry, capture resumes with the same request id", async () => {
    const paypal = new MockPayPal();
    let clock = Date.parse("2026-10-21T08:00:00Z");
    const now = () => new Date(clock);
    const first = harness({ paypal, now });
    const id = await approvedRecord(first);
    paypal.hangCapture = true;
    void first.service.capture(id); // never settles: simulates the process dying mid-request
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(first.service.getRecord(id)!.status, "CAPTURING");
    first.store.close();

    paypal.hangCapture = false;
    const second = harness({ paypal, dbPath: first.dbPath, now });
    // While the lease is valid, a second request does not start another capture.
    assert.equal((await second.service.capture(id)).code, "IN_PROGRESS");
    clock += 120_000;
    assert.equal((await second.service.capture(id)).code, "PAID");
    assert.equal(paypal.calls.capture.length, 2);
    assert.equal(paypal.calls.capture[0].requestId, paypal.calls.capture[1].requestId);
    assert.equal(paypal.totalCaptures(), 1);
  });
});

describe("not configured", () => {
  test("no credentials → NOT_CONFIGURED (503), never a fake success", async () => {
    const h = harness({ configured: false });
    const rec = h.service.createTestRecord().record!;
    const res = await handleCreateOrder(post(`/x/${rec.id}/order`), rec.id, h.service, OPTS);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { ok: boolean; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, "NOT_CONFIGURED");
    assert.equal(h.service.getRecord(rec.id)!.status, "NEW");
    assert.equal((await handleReconcile(post(`/x/${rec.id}/reconcile`), rec.id, h.service, OPTS)).status, 409);
  });
});

describe("local-only guard", () => {
  test("disabled (production) → 404; non-loopback host → 403; missing / foreign Origin → 403", async () => {
    const h = harness();
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return h.service;
    };
    assert.equal((await handleCreateRecord(post("/r"), factory, { enabled: false })).status, 404);
    assert.equal(factoryCalls, 0, "service (and its DB) must not be touched when the demo is disabled");
    assert.equal((await handleCreateRecord(post("/r", undefined, { host: "tradeproof.example.com", origin: "http://tradeproof.example.com" }), h.service, OPTS)).status, 403);
    const noOrigin = new Request(`${LOCAL}/r`, { method: "POST", headers: { host: "127.0.0.1:3000" } });
    assert.equal((await handleCreateRecord(noOrigin, h.service, OPTS)).status, 403);
    assert.equal((await handleCreateRecord(post("/r", undefined, { origin: "http://evil.example" }), h.service, OPTS)).status, 403);
    assert.equal((await handleCreateRecord(post("/r"), h.service, OPTS)).status, 201);
    const rec = h.service.listRecords()[0];
    const get = new Request(`${LOCAL}/r/${rec.id}`, { headers: { host: "127.0.0.1:3000" } });
    assert.equal((await handleGetRecord(get, rec.id, h.service, OPTS)).status, 200);
  });
});

describe("database constraints back up the state machine", () => {
  test("PAID without a capture id is rejected by the schema", () => {
    const h = harness();
    const rec = h.service.createTestRecord().record!;
    assert.throws(() => h.store.transition(rec.id, { from: ["NEW"] }, { status: "PAID" }, new Date().toISOString()));
  });
  test("one PayPal order cannot be linked to two records", () => {
    const h = harness();
    const a = h.service.createTestRecord().record!;
    const b = h.service.createTestRecord().record!;
    const nowIso = new Date().toISOString();
    h.store.transition(a.id, { from: ["NEW"] }, { status: "ORDER_CREATED", paypalOrderId: "SAMEORDER0001" }, nowIso);
    assert.throws(() => h.store.transition(b.id, { from: ["NEW"] }, { status: "ORDER_CREATED", paypalOrderId: "SAMEORDER0001" }, nowIso));
  });
});

describe("PayPal-Request-Id retention window (6 h per Orders v2 spec)", () => {
  test("window constants: 6 h documented retention, automatic retries only within 5 h", () => {
    assert.equal(PAYPAL_IDEMPOTENCY_RETENTION_MS, 6 * 3600_000);
    assert.equal(AUTO_RETRY_WINDOW_MS, 5 * 3600_000);
  });

  test("unknown capture older than the window → NEEDS_REVIEW, no automatic re-capture", async () => {
    let clock = Date.parse("2026-10-21T08:00:00Z");
    const h = harness({ now: () => new Date(clock) });
    const id = await approvedRecord(h);
    h.paypal.captureFaults = ["timeout-before-processing"];
    h.paypal.getFailures = 0;
    const getOrder = h.paypal.getOrder.bind(h.paypal);
    let failOnce = true;
    h.paypal.getOrder = async (orderId) => {
      if (failOnce && h.paypal.calls.capture.length === 1) {
        failOnce = false;
        throw new GatewayError("MOCK lookup timeout", "uncertain");
      }
      return getOrder(orderId);
    };
    assert.equal((await h.service.capture(id)).code, "CAPTURE_UNKNOWN");
    const startedAt = h.service.getRecord(id)!.captureStartedAt;
    assert.equal(startedAt, clock);

    clock += AUTO_RETRY_WINDOW_MS + 60_000; // PayPal may no longer deduplicate the old request id
    const result = await h.service.reconcile(id);
    assert.equal(result.code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.capture.length, 1, "no second capture attempt");
    const rec = h.service.getRecord(id)!;
    assert.equal(rec.status, "NEEDS_REVIEW");
    assert.equal(rec.captureStartedAt, startedAt, "start time is never reset");
    assert.ok(rec.reviewReasons[0].includes("retention window"));
  });

  test("capture retry inside the window keeps the original start time and request id", async () => {
    let clock = Date.parse("2026-10-21T08:00:00Z");
    const h = harness({ now: () => new Date(clock) });
    h.paypal.paypalNow = () => clock;
    const id = await approvedRecord(h);
    h.paypal.captureFaults = ["timeout-before-processing"];
    h.paypal.getFailures = 0;
    const getOrder = h.paypal.getOrder.bind(h.paypal);
    let failOnce = true;
    h.paypal.getOrder = async (orderId) => {
      if (failOnce && h.paypal.calls.capture.length === 1) {
        failOnce = false;
        throw new GatewayError("MOCK lookup timeout", "uncertain");
      }
      return getOrder(orderId);
    };
    const t0 = clock;
    assert.equal((await h.service.capture(id)).code, "CAPTURE_UNKNOWN");
    clock += AUTO_RETRY_WINDOW_MS - 60_000;
    assert.equal((await h.service.reconcile(id)).code, "PAID");
    assert.equal(h.paypal.calls.capture[0].requestId, h.paypal.calls.capture[1].requestId);
    assert.equal(h.service.getRecord(id)!.captureStartedAt, t0);
  });

  test("unknown create older than the window → not retried (FAILED with review reason), no new create call", async () => {
    let clock = Date.parse("2026-10-21T08:00:00Z");
    const paypal = new MockPayPal();
    const h = harness({ paypal, now: () => new Date(clock) });
    const rec = h.service.createTestRecord().record!;
    paypal.createOrder = async (input, requestId) => {
      paypal.calls.create.push({ requestId, input });
      throw new GatewayError("MOCK create order: no definite response (TimeoutError)", "uncertain");
    };
    assert.equal((await h.service.createPayPalOrder(rec.id)).code, "CREATE_UNKNOWN");
    assert.equal(h.service.getRecord(rec.id)!.createStartedAt, clock);
    clock += AUTO_RETRY_WINDOW_MS + 60_000;
    const result = await h.service.reconcile(rec.id);
    assert.equal(result.code, "FAILED");
    assert.equal(paypal.calls.create.length, 1);
    assert.ok(h.service.getRecord(rec.id)!.reviewReasons[0].includes("retention window"));
  });

  test("schema v1 database (from the previous phase) migrates to v2 without losing records", () => {
    const dbPath = newDbPath();
    const v2 = new PaymentStore(dbPath);
    const svc = new PaymentService({ store: v2, gateway: null, payeeMerchantId: null });
    const id = svc.createTestRecord().record!.id;
    v2.close();
    // Turn it back into a v1 file, as created by commit 9f5e253.
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "ALTER TABLE sandbox_payment_records DROP COLUMN capture_started_paypal_at; ALTER TABLE sandbox_payment_records DROP COLUMN create_started_at; ALTER TABLE sandbox_payment_records DROP COLUMN capture_started_at; PRAGMA user_version = 1;",
    );
    raw.close();
    const migrated = new PaymentStore(dbPath);
    openStores.push(migrated);
    const rec = migrated.get(id)!;
    assert.equal(rec.status, "NEW");
    assert.equal(rec.createStartedAt, null);
    assert.equal(rec.captureStartedAt, null);
  });
});

// Found 21 Oct 2026: this machine's wall clock was 62.7 min slow (PayPal / Microsoft / Cloudflare Date
// headers) and the System log shows repeated large forward corrections, i.e. the local clock loses time.
// A local-only elapsed time can then understate the real time since the first capture attempt.
describe("retry window does not trust the local clock alone (MOCK)", () => {
  async function unknownCapture(options: { local: () => number; paypal: (() => number) | undefined }) {
    const h = harness({ now: () => new Date(options.local()) });
    h.paypal.paypalNow = options.paypal;
    const id = await approvedRecord(h);
    h.paypal.captureFaults = ["timeout-before-processing"];
    const getOrder = h.paypal.getOrder.bind(h.paypal);
    let failOnce = true;
    h.paypal.getOrder = async (orderId) => {
      if (failOnce && h.paypal.calls.capture.length === 1) {
        failOnce = false;
        throw new GatewayError("MOCK lookup timeout", "uncertain");
      }
      return getOrder(orderId);
    };
    assert.equal((await h.service.capture(id)).code, "CAPTURE_UNKNOWN");
    return { h, id };
  }

  test("PayPal Date header is parsed as the independent clock", () => {
    assert.equal(serverTime({ date: "Wed, 21 Oct 2026 10:52:45 GMT" }), Date.parse("2026-10-21T10:52:45Z"));
    assert.equal(serverTime({ Date: "Wed, 21 Oct 2026 10:52:45 GMT" }), Date.parse("2026-10-21T10:52:45Z"));
    assert.equal(serverTime({}), undefined);
    assert.equal(serverTime({ date: "not a date" }), undefined);
  });

  test("first capture stores PayPal's clock next to the local one (local clock 62.7 min slow)", async () => {
    const local = Date.parse("2026-10-21T09:23:46Z");
    const skew = 3_762_700;
    const { h, id } = await unknownCapture({ local: () => local, paypal: () => local + skew });
    const rec = h.service.getRecord(id)!;
    assert.equal(rec.captureStartedAt, local);
    assert.equal(rec.captureStartedPayPalAt, Math.floor((local + skew) / 1000) * 1000);
  });

  test("a constant local offset alone does not block a legitimate retry", async () => {
    let real = Date.parse("2026-10-21T10:26:29Z");
    const skew = 3_762_700;
    const { h, id } = await unknownCapture({ local: () => real - skew, paypal: () => real });
    real += 10 * 60_000;
    assert.equal((await h.service.reconcile(id)).code, "PAID");
    assert.equal(h.paypal.calls.capture[0].requestId, h.paypal.calls.capture[1].requestId);
  });

  test("local clock LOST 2 h: local says 3.5 h, PayPal says 5.5 h → NEEDS_REVIEW, no re-capture", async () => {
    let real = Date.parse("2026-10-21T08:00:00Z");
    let lost = 0;
    const { h, id } = await unknownCapture({ local: () => real - lost, paypal: () => real });
    real += 5.5 * 3_600_000;
    lost = 2 * 3_600_000;
    const result = await h.service.reconcile(id);
    assert.equal(result.code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.capture.length, 1, "no second capture attempt");
    assert.ok(h.service.getRecord(id)!.reviewReasons[0].includes("PayPal clock: outside or unknown"));
  });

  test("local clock SET BACK (start time now in the future) → NEEDS_REVIEW, no re-capture", async () => {
    let local = Date.parse("2026-10-21T08:00:00Z");
    const { h, id } = await unknownCapture({ local: () => local, paypal: () => Date.parse("2026-10-21T08:00:00Z") });
    local -= 3_600_000; // clock moved back one hour
    assert.equal((await h.service.reconcile(id)).code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.ok(h.service.getRecord(id)!.reviewReasons[0].includes("local clock: outside or unknown"));
  });

  test("no PayPal Date header at retry time → not provable → NEEDS_REVIEW", async () => {
    const start = Date.parse("2026-10-21T08:00:00Z");
    const { h, id } = await unknownCapture({ local: () => start, paypal: () => start });
    h.paypal.paypalNow = undefined;
    assert.equal((await h.service.reconcile(id)).code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.capture.length, 1);
  });

  test("no PayPal time stored for the first attempt (header missing then) → NEEDS_REVIEW", async () => {
    const start = Date.parse("2026-10-21T08:00:00Z");
    const { h, id } = await unknownCapture({ local: () => start, paypal: undefined });
    assert.equal(h.service.getRecord(id)!.captureStartedPayPalAt, null);
    h.paypal.paypalNow = () => start;
    assert.equal((await h.service.reconcile(id)).code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.capture.length, 1);
  });

  test("after NEEDS_REVIEW, read-only reconcile still queries PayPal but never captures", async () => {
    let local = Date.parse("2026-10-21T08:00:00Z");
    const { h, id } = await unknownCapture({ local: () => local, paypal: () => Date.parse("2026-10-21T08:00:00Z") });
    local -= 3_600_000;
    assert.equal((await h.service.reconcile(id)).code, "NEEDS_REVIEW");
    const gets = h.paypal.calls.get.length;
    const again = await h.service.reconcile(id);
    assert.equal(again.code, "NEEDS_REVIEW");
    assert.equal(h.paypal.calls.get.length, gets + 1, "lookup still performed");
    assert.equal(h.paypal.calls.capture.length, 1);
  });

  test("create retry with a start time in the future (clock set back) → not retried", async () => {
    let clock = Date.parse("2026-10-21T08:00:00Z");
    const paypal = new MockPayPal();
    const h = harness({ paypal, now: () => new Date(clock) });
    const rec = h.service.createTestRecord().record!;
    paypal.createOrder = async (input, requestId) => {
      paypal.calls.create.push({ requestId, input });
      throw new GatewayError("MOCK create order: no definite response (TimeoutError)", "uncertain");
    };
    assert.equal((await h.service.createPayPalOrder(rec.id)).code, "CREATE_UNKNOWN");
    clock -= 3_600_000;
    assert.equal((await h.service.reconcile(rec.id)).code, "FAILED");
    assert.equal(paypal.calls.create.length, 1);
  });

  test("schema v2 database migrates to v3 keeping records", () => {
    const dbPath = newDbPath();
    const v3 = new PaymentStore(dbPath);
    const svc = new PaymentService({ store: v3, gateway: null, payeeMerchantId: null });
    const id = svc.createTestRecord().record!.id;
    v3.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE sandbox_payment_records DROP COLUMN capture_started_paypal_at; PRAGMA user_version = 2;");
    raw.close();
    const migrated = new PaymentStore(dbPath);
    openStores.push(migrated);
    assert.equal(migrated.get(id)!.captureStartedPayPalAt, null);
  });
});
