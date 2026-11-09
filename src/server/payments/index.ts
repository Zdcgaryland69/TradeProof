// Server-only entry point used by route handlers and server components.
import "server-only";

import { createHash } from "node:crypto";
import { APP_DB_PATH } from "../db/location.ts";
import { publicConfig, readPayPalConfig, type PublicPayPalConfig } from "./config.ts";
import { createPayPalGateway } from "./paypal-gateway.ts";
import { PaymentService } from "./service.ts";
import { PaymentStore } from "./store.ts";

/** Local database file (Git-ignored), shared with the procurement tables since schema v4. */
export const PAYMENTS_DB_PATH = APP_DB_PATH;

interface Holder {
  fingerprint: string;
  service: PaymentService;
  store: PaymentStore;
}

// Kept on globalThis so dev hot-reloads reuse one DB connection. Rebuilt when .env.local changes.
const holder = globalThis as typeof globalThis & { __tradeproofPayments?: Holder };

function fingerprint(): string {
  const keys = ["PAYPAL_ENVIRONMENT", "PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_EXPECTED_PAYEE_MERCHANT_ID"];
  return createHash("sha256")
    .update(keys.map((k) => `${k}=${process.env[k] ?? ""}`).join("\n"))
    .digest("hex");
}

export function getPaymentService(): PaymentService {
  const fp = fingerprint();
  const current = holder.__tradeproofPayments;
  if (current && current.fingerprint === fp) return current.service;

  const cfg = readPayPalConfig();
  const store = current?.store ?? new PaymentStore(PAYMENTS_DB_PATH);
  const service = new PaymentService({
    store,
    gateway: cfg.configured ? createPayPalGateway(cfg) : null,
    payeeMerchantId: cfg.configured ? cfg.payeeMerchantId : null,
  });
  holder.__tradeproofPayments = { fingerprint: fp, service, store };
  return service;
}

export function getPublicPayPalConfig(): PublicPayPalConfig {
  return publicConfig(readPayPalConfig());
}

export { sandboxDemoEnabled } from "./demo-switch.ts";
