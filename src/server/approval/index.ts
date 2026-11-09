// Server-only entry point used by the approval route handlers and page.
import "server-only";

import path from "node:path";
import { getAuthService } from "../auth/index.ts";
import { getClarificationStore } from "../clarification/index.ts";
import { APP_DB_PATH } from "../db/location.ts";
import { ExtractionStore } from "../extraction/store.ts";
import { readPayPalConfig } from "../payments/config.ts";
import { getPaymentService } from "../payments/index.ts";
import { FileMockPayPal } from "../payments/mock-gateway.ts";
import { PaymentService } from "../payments/service.ts";
import { PaymentStore } from "../payments/store.ts";
import { getProcurementStore } from "../procurement/index.ts";
import { getReplyService } from "../replies/index.ts";
import { ReplyStore } from "../replies/store.ts";
import { currentApprovalPaymentMode } from "./http.ts";
import { paymentLabel } from "./payment-mode.ts";
import { ApprovalService } from "./service.ts";
import { ApprovalStore } from "./store.ts";

export { approvalPaymentsEnabled, approvalPaymentsRefusedReason, currentApprovalPaymentMode } from "./http.ts";

/** MOCK payee when PayPal is not configured (MOCK mode only; never a real account). */
const MOCK_PAYEE = "MOCKPAYEE0001";

// Same local SQLite file (schema v14). Opened lazily, never at import or build time; kept on globalThis so dev
// hot-reloads reuse one connection. No model client is created here; the PayPal client only when a payment step runs.
// MOCK mode (database copy only) swaps in a file-backed MOCK gateway: no network, nothing sent to PayPal.
const holder = globalThis as typeof globalThis & { __tradeproofApprovals?: ApprovalService; __tradeproofMockPayments?: { gateway: FileMockPayPal; service: PaymentService } };

const isMock = () => currentApprovalPaymentMode().mode === "MOCK";

function realPayee() {
  const cfg = readPayPalConfig();
  return cfg.configured ? { configured: true, merchantId: cfg.payeeMerchantId } : { configured: false, merchantId: null };
}

/** The MOCK gateway and its payment service, or null outside MOCK mode. */
export function getMockApprovalPayments(): { gateway: FileMockPayPal; service: PaymentService } | null {
  if (!isMock()) return null;
  if (!holder.__tradeproofMockPayments) {
    const payee = realPayee().merchantId ?? MOCK_PAYEE;
    const gateway = new FileMockPayPal(path.join(path.dirname(APP_DB_PATH), `${path.basename(APP_DB_PATH)}.mock-paypal.json`), payee);
    holder.__tradeproofMockPayments = { gateway, service: new PaymentService({ store: new PaymentStore(APP_DB_PATH), gateway, payeeMerchantId: payee, simulated: true }) };
  }
  return holder.__tradeproofMockPayments;
}

export function getApprovalService(): ApprovalService {
  const onBackup = (file: string) => console.info(`[db] backup written before migration: ${file}`);
  holder.__tradeproofApprovals ??= new ApprovalService({
    store: new ApprovalStore(APP_DB_PATH, { onBackup }),
    extraction: new ExtractionStore(APP_DB_PATH, { onBackup }),
    procurement: getProcurementStore(),
    replies: getReplyService(),
    replyStore: new ReplyStore(APP_DB_PATH, { onBackup }),
    drafts: getClarificationStore(),
    payments: () => getMockApprovalPayments()?.service ?? getPaymentService(),
    payee: () => {
      const p = realPayee();
      return isMock() && !p.configured ? { configured: true, merchantId: MOCK_PAYEE } : p;
    },
    paymentLabel: () => paymentLabel(currentApprovalPaymentMode()),
    accountName: (id) => getAuthService().store.account(id)?.displayName ?? null,
  });
  return holder.__tradeproofApprovals;
}
