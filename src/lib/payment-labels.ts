// Payment wording by the RECORD's own kind (9 Nov). A record's kind comes from its stored sku (TP-APPROVAL-MOCK for
// the simulated gateway, TP-APPROVAL for PayPal Sandbox), never from the server's current mode: a Sandbox payment seen
// on a MOCK server stays a PayPal Sandbox payment, and a MOCK payment never reads as a PayPal one. Display only.

import { en } from "../i18n/en.ts";

export type PaymentKind = "MOCK" | "SANDBOX";

export function paymentKind(sku: string): PaymentKind {
  return sku.includes("MOCK") ? "MOCK" : "SANDBOX";
}

const p = en.approval.pay;

export function paymentLabels(kind: PaymentKind) {
  const mock = kind === "MOCK";
  return {
    order: mock ? p.facts.orderMock : p.facts.order,
    capture: mock ? p.facts.captureMock : p.facts.capture,
    reconcile: mock ? p.reconcileMock : p.reconcile,
    createOrder: mock ? p.createOrderMock : p.createOrder,
    /** Help line next to a record's status pill. */
    statusHelp: (status: string): string => (mock ? (p.statusHelp[`MOCK_${status}`] ?? p.statusHelp[status]) : p.statusHelp[status]) ?? "",
  };
}
