// MOCK PayPal gateway for local browser checks (30 Oct) — SIMULATED responses, no network, no real Sandbox, no money.
// Used only when approval payments run in MOCK mode, which is refused on the app's main database (payment-mode.ts).
//
// State is kept in a JSON file next to the database copy so that a dev-server restart sees the same "PayPal side"
// (orders, captures, idempotency keys). Behaviour mirrors the Orders v2 parts the payment module relies on, as the
// test double in tests/mock-paypal.ts does: idempotent create / capture per PayPal-Request-Id, one capture per order
// (ORDER_ALREADY_CAPTURED), capture only after (simulated) buyer approval. A browser check can queue capture faults
// ("timeout-before-processing" / "timeout-after-processing") in the file to simulate an unknown outcome.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { GatewayError, type CreateOrderInput, type GatewayOrder, type PayPalGateway } from "./types.ts";

export type MockCaptureFault = "timeout-before-processing" | "timeout-after-processing";

export interface MockState {
  label: "MOCK";
  seq: number;
  orders: Record<string, GatewayOrder>;
  createByRequestId: Record<string, string>;
  captureByRequestId: Record<string, GatewayOrder>;
  captureFaults: MockCaptureFault[];
  calls: { create: number; get: number; capture: number };
}

const empty = (): MockState => ({ label: "MOCK", seq: 0, orders: {}, createByRequestId: {}, captureByRequestId: {}, captureFaults: [], calls: { create: 0, get: 0, capture: 0 } });

export class FileMockPayPal implements PayPalGateway {
  readonly label = "MOCK";
  private readonly file: string;
  private readonly payeeMerchantId: string;

  constructor(file: string, payeeMerchantId: string) {
    this.file = file;
    this.payeeMerchantId = payeeMerchantId;
  }

  read(): MockState {
    return existsSync(this.file) ? { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as MockState) } : empty();
  }

  private write(s: MockState): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    renameSync(tmp, this.file);
  }

  private stamp(order: GatewayOrder): GatewayOrder {
    return { ...structuredClone(order), serverTimeMs: Math.floor(Date.now() / 1000) * 1000 };
  }

  async createOrder(input: CreateOrderInput, requestId: string): Promise<GatewayOrder> {
    const s = this.read();
    s.calls.create++;
    const existing = s.createByRequestId[requestId];
    if (existing) {
      this.write(s);
      return this.stamp(s.orders[existing]);
    }
    const id = `MOCKORDER${String(++s.seq).padStart(8, "0")}`;
    s.orders[id] = {
      id,
      status: "CREATED",
      purchaseUnits: [{ referenceId: input.localId, customId: input.localId, invoiceId: input.localId, amount: structuredClone(input.amount), payeeMerchantId: this.payeeMerchantId, captures: [] }],
    };
    s.createByRequestId[requestId] = id;
    this.write(s);
    return this.stamp(s.orders[id]);
  }

  /** Simulates the buyer approving in the PayPal window (MOCK only). */
  approve(orderId: string): boolean {
    const s = this.read();
    const order = s.orders[orderId];
    if (!order) return false;
    if (order.status === "CREATED") order.status = "APPROVED";
    this.write(s);
    return true;
  }

  async getOrder(orderId: string): Promise<GatewayOrder> {
    const s = this.read();
    s.calls.get++;
    this.write(s);
    const order = s.orders[orderId];
    if (!order) throw new GatewayError("MOCK get order failed", "rejected", { httpStatus: 404, issue: "RESOURCE_NOT_FOUND" });
    return this.stamp(order);
  }

  async captureOrder(orderId: string, requestId: string): Promise<GatewayOrder> {
    const s = this.read();
    s.calls.capture++;
    const fault = s.captureFaults.shift();
    const finish = (out: () => GatewayOrder) => {
      this.write(s);
      return out();
    };
    if (fault === "timeout-before-processing") {
      this.write(s);
      throw new GatewayError("MOCK capture order: no definite response (TimeoutError)", "uncertain");
    }
    const cached = s.captureByRequestId[requestId];
    if (cached) return finish(() => this.stamp(cached));
    const order = s.orders[orderId];
    if (!order) {
      this.write(s);
      throw new GatewayError("MOCK capture order failed", "rejected", { httpStatus: 404, issue: "RESOURCE_NOT_FOUND" });
    }
    if (order.status === "COMPLETED") {
      this.write(s);
      throw new GatewayError("MOCK capture order failed", "rejected", { httpStatus: 422, issue: "ORDER_ALREADY_CAPTURED" });
    }
    if (order.status !== "APPROVED") {
      this.write(s);
      throw new GatewayError("MOCK capture order failed", "rejected", { httpStatus: 422, issue: "ORDER_NOT_APPROVED" });
    }
    const unit = order.purchaseUnits[0];
    unit.captures.push({ id: `MOCKCAPTURE${String(++s.seq).padStart(6, "0")}`, status: "COMPLETED", amount: structuredClone(unit.amount!) });
    order.status = "COMPLETED";
    s.captureByRequestId[requestId] = structuredClone(order);
    if (fault === "timeout-after-processing") {
      this.write(s);
      throw new GatewayError("MOCK capture order: no definite response (TimeoutError)", "uncertain");
    }
    return finish(() => this.stamp(order));
  }

  /** Captures that exist on the MOCK "PayPal side" across all orders. */
  totalCaptures(): number {
    return Object.values(this.read().orders).reduce((n, o) => n + o.purchaseUnits.reduce((m, u) => m + u.captures.length, 0), 0);
  }
}
