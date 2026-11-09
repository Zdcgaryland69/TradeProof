// Shared types for the PayPal Sandbox payment spike.
// Deliberately free of SDK / Next.js imports so the logic can be unit-tested with plain `node --test`.

export const RECORD_STATUSES = [
  "NEW", // local test record exists, no PayPal order yet
  "ORDER_CREATING", // create call in flight (or result unknown) — retried with the SAME PayPal-Request-Id
  "ORDER_CREATED", // PayPal order exists, waiting for buyer approval
  "CAPTURING", // capture call in flight
  "CAPTURE_UNKNOWN", // capture result unknown (timeout / 5xx) — must reconcile, never assume unpaid
  "CAPTURE_PENDING", // PayPal reports the capture as PENDING — not paid yet
  "PAID", // capture verified against PayPal: order, capture, amount, currency, payee
  "NEEDS_REVIEW", // PayPal data did not match expectations — never auto-marked paid
  "FAILED", // PayPal definitively rejected the operation
] as const;

export type RecordStatus = (typeof RECORD_STATUSES)[number];

export interface PaymentRecord {
  id: string;
  sku: string;
  itemName: string;
  amountMinor: number;
  currency: string;
  status: RecordStatus;
  createRequestId: string;
  captureRequestId: string | null;
  /** Epoch ms when create_request_id was first sent to PayPal. */
  createStartedAt: number | null;
  /** Epoch ms when capture_request_id was first sent to PayPal. */
  captureStartedAt: number | null;
  /** PayPal's clock (HTTP Date header of the GET just before the first capture attempt), epoch ms. */
  captureStartedPayPalAt: number | null;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paypalOrderStatus: string | null;
  paypalCaptureStatus: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  reviewReasons: string[];
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

export interface GatewayMoney {
  currencyCode: string;
  value: string;
}

export interface GatewayCapture {
  id?: string;
  status?: string;
  amount?: GatewayMoney;
}

export interface GatewayPurchaseUnit {
  referenceId?: string;
  customId?: string;
  invoiceId?: string;
  amount?: GatewayMoney;
  payeeMerchantId?: string;
  captures: GatewayCapture[];
}

/** The subset of a PayPal Orders v2 order this module relies on. */
export interface GatewayOrder {
  id?: string;
  status?: string;
  purchaseUnits: GatewayPurchaseUnit[];
  /** PayPal server time of this response (HTTP Date header), epoch ms; absent if not provided. */
  serverTimeMs?: number;
}

export interface CreateOrderInput {
  localId: string;
  description: string;
  amount: GatewayMoney;
}

/** Port to PayPal. The real implementation wraps the official SDK; tests use a labelled mock. */
export interface PayPalGateway {
  createOrder(input: CreateOrderInput, paypalRequestId: string): Promise<GatewayOrder>;
  getOrder(orderId: string): Promise<GatewayOrder>;
  captureOrder(orderId: string, paypalRequestId: string): Promise<GatewayOrder>;
}

export type GatewayCertainty =
  /** PayPal may or may not have performed the operation (network error, timeout, 5xx, 408, 429). */
  | "uncertain"
  /** PayPal answered with a definite 4xx rejection. */
  | "rejected";

export class GatewayError extends Error {
  readonly certainty: GatewayCertainty;
  readonly httpStatus: number | undefined;
  readonly issue: string | undefined;
  readonly debugId: string | undefined;

  constructor(
    message: string,
    certainty: GatewayCertainty,
    details: { httpStatus?: number; issue?: string; debugId?: string } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.certainty = certainty;
    this.httpStatus = details.httpStatus;
    this.issue = details.issue;
    this.debugId = details.debugId;
  }
}
