// The controlled switch for approval payments (30 Oct). Read on the server from the environment only; the browser
// cannot change it.
//
//   TRADEPROOF_APPROVAL_PAYMENTS unset / empty → OFF      every payment step 409 PAYMENTS_NOT_ENABLED, nothing written
//   TRADEPROOF_APPROVAL_PAYMENTS=sandbox       → SANDBOX  real PayPal Sandbox calls; only on the app's main database
//   TRADEPROOF_APPROVAL_PAYMENTS=mock          → MOCK     simulated PayPal, no network; only when TRADEPROOF_DB_PATH
//                                                         points at another file (a copy), so MOCK payment records
//                                                         never enter the main database
//   anything else, or a combination refused above → REFUSED (treated as OFF, with the reason shown)

import path from "node:path";

export type ApprovalPaymentMode = { mode: "OFF" } | { mode: "SANDBOX" } | { mode: "MOCK" } | { mode: "REFUSED"; reason: string };

type Env = Record<string, string | undefined>;

export function approvalPaymentMode(env: Env, appDbPath: string, defaultDbPath: string): ApprovalPaymentMode {
  const value = (env.TRADEPROOF_APPROVAL_PAYMENTS ?? "").trim();
  const onMain = path.resolve(appDbPath).toLowerCase() === path.resolve(defaultDbPath).toLowerCase();
  if (value === "") return { mode: "OFF" };
  if (value === "sandbox") {
    return onMain ? { mode: "SANDBOX" } : { mode: "REFUSED", reason: "Sandbox payments run only on the app's main database (TRADEPROOF_DB_PATH points elsewhere)." };
  }
  if (value === "mock") {
    return onMain ? { mode: "REFUSED", reason: "MOCK payments are refused on the main database; set TRADEPROOF_DB_PATH to a copy." } : { mode: "MOCK" };
  }
  return { mode: "REFUSED", reason: 'TRADEPROOF_APPROVAL_PAYMENTS must be empty, "sandbox" or "mock".' };
}

export const paymentsEnabledIn = (m: ApprovalPaymentMode) => m.mode === "SANDBOX" || m.mode === "MOCK";

/** Payment record labels: a MOCK record can never be mistaken for a Sandbox one. */
export function paymentLabel(m: ApprovalPaymentMode): { sku: string; suffix: string } {
  return m.mode === "MOCK" ? { sku: "TP-APPROVAL-MOCK", suffix: "(MOCK PayPal — no PayPal request)" } : { sku: "TP-APPROVAL", suffix: "(Sandbox)" };
}
