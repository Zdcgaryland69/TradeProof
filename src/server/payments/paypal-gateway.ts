// Real PayPal gateway: official TypeScript Server SDK (@paypal/paypal-server-sdk 2.5.0, Orders v2).
// Verified in the SDK source (src/controllers/ordersController.ts, src/defaultConfiguration.ts):
// - PayPal-Request-Id is only sent when `paypalRequestId` is passed; the SDK never generates one;
// - default timeout is 0 (none) and default retries are 0 for POST — both set explicitly here.

import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  type Order,
} from "@paypal/paypal-server-sdk";
import { GatewayError, type CreateOrderInput, type GatewayOrder, type PayPalGateway } from "./types.ts";

const REQUEST_TIMEOUT_MS = 20_000;

/** PayPal's HTTP Date header (server clock), used as an independent clock for the retry window. */
export function serverTime(headers: Record<string, string> | undefined): number | undefined {
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === "date");
  const ms = key ? Date.parse(headers![key]) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

function mapOrder(order: Order, headers?: Record<string, string>): GatewayOrder {
  return {
    serverTimeMs: serverTime(headers),
    id: order.id,
    status: order.status,
    purchaseUnits: (order.purchaseUnits ?? []).map((unit) => ({
      referenceId: unit.referenceId,
      customId: unit.customId,
      invoiceId: unit.invoiceId,
      amount: unit.amount ? { currencyCode: unit.amount.currencyCode, value: unit.amount.value } : undefined,
      payeeMerchantId: unit.payee?.merchantId,
      captures: (unit.payments?.captures ?? []).map((capture) => ({
        id: capture.id,
        status: capture.status,
        amount: capture.amount ? { currencyCode: capture.amount.currencyCode, value: capture.amount.value } : undefined,
      })),
    })),
  };
}

interface ErrorPayload {
  name?: string;
  debug_id?: string;
  details?: { issue?: string }[];
}

function payloadOf(err: ApiError): ErrorPayload | undefined {
  if (err.result && typeof err.result === "object") return err.result as ErrorPayload;
  if (typeof err.body === "string") {
    try {
      return JSON.parse(err.body) as ErrorPayload;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function toGatewayError(err: unknown, operation: string): GatewayError {
  if (err instanceof ApiError) {
    const status = err.statusCode;
    const payload = payloadOf(err);
    const issue = payload?.details?.[0]?.issue ?? payload?.name;
    // 5xx / 408 / 429: PayPal may have processed it. 401/403: auth problem, nothing known about the
    // operation itself — also treated as "uncertain" so state is resolved by a later lookup.
    const uncertain = status >= 500 || status === 408 || status === 429 || status === 401 || status === 403;
    return new GatewayError(`PayPal ${operation} failed`, uncertain ? "uncertain" : "rejected", {
      httpStatus: status,
      issue,
      debugId: payload?.debug_id,
    });
  }
  // Network error, timeout, abort: no definite answer from PayPal.
  const kind = err instanceof Error ? err.name : "error";
  return new GatewayError(`PayPal ${operation}: no definite response (${kind})`, "uncertain");
}

export function createPayPalGateway(credentials: { clientId: string; clientSecret: string }): PayPalGateway {
  const client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: credentials.clientId,
      oAuthClientSecret: credentials.clientSecret,
    },
    environment: Environment.Sandbox, // fixed: no Live path in this phase
    timeout: REQUEST_TIMEOUT_MS,
    httpClientOptions: { timeout: REQUEST_TIMEOUT_MS, retryConfig: { maxNumberOfRetries: 0 } },
    // No logging option: the SDK default is a NullLogger, so tokens and bodies are not logged.
  });
  const orders = new OrdersController(client);

  return {
    async createOrder(input: CreateOrderInput, paypalRequestId: string): Promise<GatewayOrder> {
      try {
        const response = await orders.createOrder({
          paypalRequestId,
          prefer: "return=representation",
          body: {
            intent: CheckoutPaymentIntent.Capture,
            purchaseUnits: [
              {
                referenceId: input.localId,
                customId: input.localId,
                invoiceId: input.localId,
                description: input.description,
                amount: { currencyCode: input.amount.currencyCode, value: input.amount.value },
              },
            ],
          },
        });
        return mapOrder(response.result, response.headers);
      } catch (err) {
        throw toGatewayError(err, "create order");
      }
    },

    async getOrder(orderId: string): Promise<GatewayOrder> {
      try {
        const response = await orders.getOrder({ id: orderId });
        return mapOrder(response.result, response.headers);
      } catch (err) {
        throw toGatewayError(err, "get order");
      }
    },

    async captureOrder(orderId: string, paypalRequestId: string): Promise<GatewayOrder> {
      try {
        const response = await orders.captureOrder({ id: orderId, paypalRequestId, prefer: "return=representation" });
        return mapOrder(response.result, response.headers);
      } catch (err) {
        throw toGatewayError(err, "capture order");
      }
    },
  };
}
