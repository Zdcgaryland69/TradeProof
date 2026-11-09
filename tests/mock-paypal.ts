// MOCK PayPal gateway for automated tests — SIMULATED responses, no network, no real Sandbox.
// It mimics the Orders v2 behaviours the payment module depends on: idempotent create/capture by
// PayPal-Request-Id, one capture per order (ORDER_ALREADY_CAPTURED), approval, and lost responses.

import {
  GatewayError,
  type CreateOrderInput,
  type GatewayOrder,
  type PayPalGateway,
} from "../src/server/payments/types.ts";

export const MOCK_PAYEE = "MOCKPAYEE0001";

export type CaptureFault =
  | "none"
  | "timeout-before-processing" // PayPal never processed the capture
  | "timeout-after-processing"; // PayPal captured, but the response was lost

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = <T>(value: T): T => structuredClone(value);

export class MockPayPal implements PayPalGateway {
  readonly label = "MOCK";
  private readonly orders = new Map<string, GatewayOrder>();
  private readonly createByRequestId = new Map<string, string>();
  private readonly captureByRequestId = new Map<string, GatewayOrder>();
  private seq = 0;

  calls = {
    create: [] as { requestId: string; input: CreateOrderInput }[],
    get: [] as string[],
    capture: [] as { orderId: string; requestId: string }[],
  };
  payeeMerchantId = MOCK_PAYEE;
  createDelayMs = 0;
  captureDelayMs = 0;
  captureFaults: CaptureFault[] = [];
  captureStatus = "COMPLETED";
  getFailures = 0;
  /** Mutates order snapshots returned by getOrder (to simulate unexpected PayPal data). */
  tamperGet: ((order: GatewayOrder) => void) | null = null;
  /** Never resolve capture calls (simulates a process that dies mid-request). */
  hangCapture = false;
  /** MOCK PayPal server clock (what the real API sends as the HTTP Date header). undefined → no header. */
  paypalNow: (() => number) | undefined = () => Date.now();

  private stamp(order: GatewayOrder): GatewayOrder {
    const now = this.paypalNow?.();
    return now === undefined ? order : { ...order, serverTimeMs: Math.floor(now / 1000) * 1000 };
  }

  async createOrder(input: CreateOrderInput, requestId: string): Promise<GatewayOrder> {
    this.calls.create.push({ requestId, input: clone(input) });
    if (this.createDelayMs) await delay(this.createDelayMs);
    const existing = this.createByRequestId.get(requestId);
    if (existing) return this.stamp(clone(this.orders.get(existing)!));
    const id = `MOCKORDER${String(++this.seq).padStart(8, "0")}`;
    this.orders.set(id, {
      id,
      status: "CREATED",
      purchaseUnits: [
        {
          referenceId: input.localId,
          customId: input.localId,
          invoiceId: input.localId,
          amount: clone(input.amount),
          payeeMerchantId: this.payeeMerchantId,
          captures: [],
        },
      ],
    });
    this.createByRequestId.set(requestId, id);
    return this.stamp(clone(this.orders.get(id)!));
  }

  /** Simulates the buyer approving in the PayPal window. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`MOCK: unknown order ${orderId}`);
    if (order.status === "CREATED") order.status = "APPROVED";
  }

  /** Inserts an order that was not created through this app (a "foreign" order). */
  addForeignOrder(id: string, value = "1.00"): void {
    this.orders.set(id, {
      id,
      status: "APPROVED",
      purchaseUnits: [
        { referenceId: "someone-else", customId: "someone-else", amount: { currencyCode: "USD", value }, payeeMerchantId: this.payeeMerchantId, captures: [] },
      ],
    });
  }

  async getOrder(orderId: string): Promise<GatewayOrder> {
    this.calls.get.push(orderId);
    if (this.getFailures > 0) {
      this.getFailures--;
      throw new GatewayError("MOCK get order: no definite response (TimeoutError)", "uncertain");
    }
    const order = this.orders.get(orderId);
    if (!order) throw new GatewayError("MOCK get order failed", "rejected", { httpStatus: 404, issue: "RESOURCE_NOT_FOUND" });
    const snapshot = clone(order);
    this.tamperGet?.(snapshot);
    return this.stamp(snapshot);
  }

  async captureOrder(orderId: string, requestId: string): Promise<GatewayOrder> {
    this.calls.capture.push({ orderId, requestId });
    if (this.hangCapture) return new Promise<GatewayOrder>(() => {});
    if (this.captureDelayMs) await delay(this.captureDelayMs);
    const fault = this.captureFaults.shift() ?? "none";
    if (fault === "timeout-before-processing") {
      throw new GatewayError("MOCK capture order: no definite response (TimeoutError)", "uncertain");
    }
    const cached = this.captureByRequestId.get(requestId);
    if (cached) return this.stamp(clone(cached)); // PayPal idempotency: same request id → same result, no new capture
    const order = this.orders.get(orderId);
    if (!order) throw new GatewayError("MOCK capture order failed", "rejected", { httpStatus: 404, issue: "RESOURCE_NOT_FOUND" });
    if (order.status === "COMPLETED") {
      throw new GatewayError("MOCK capture order failed", "rejected", { httpStatus: 422, issue: "ORDER_ALREADY_CAPTURED" });
    }
    if (order.status !== "APPROVED") {
      throw new GatewayError("MOCK capture order failed", "rejected", { httpStatus: 422, issue: "ORDER_NOT_APPROVED" });
    }
    const unit = order.purchaseUnits[0];
    unit.captures.push({ id: `MOCKCAPTURE${String(++this.seq).padStart(6, "0")}`, status: this.captureStatus, amount: clone(unit.amount!) });
    order.status = "COMPLETED";
    this.captureByRequestId.set(requestId, clone(order));
    if (fault === "timeout-after-processing") {
      throw new GatewayError("MOCK capture order: no definite response (TimeoutError)", "uncertain");
    }
    return this.stamp(clone(order));
  }

  /** Total captures that exist at the (mock) PayPal side across all orders. */
  totalCaptures(): number {
    let n = 0;
    for (const order of this.orders.values()) n += order.purchaseUnits.reduce((sum, u) => sum + u.captures.length, 0);
    return n;
  }
}
