// Deterministic checks of PayPal order data against the local record. A record is only ever
// marked PAID when `verifyCapturedOrder` returns verdict "PAID" with no problems.

import { toMinorUnits } from "./money.ts";
import type { GatewayMoney, GatewayOrder, PaymentRecord } from "./types.ts";

export interface Expectation {
  localId: string;
  paypalOrderId: string;
  amountMinor: number;
  currency: string;
  payeeMerchantId: string;
  /** Capture id already known for this record (from the capture response), if any. */
  captureId?: string | null;
}

export function expectationFor(record: PaymentRecord, payeeMerchantId: string): Expectation {
  if (!record.paypalOrderId) throw new Error("Record has no PayPal order id");
  return {
    localId: record.id,
    paypalOrderId: record.paypalOrderId,
    amountMinor: record.amountMinor,
    currency: record.currency,
    payeeMerchantId,
    captureId: record.paypalCaptureId,
  };
}

function moneyProblems(label: string, money: GatewayMoney | undefined, exp: Expectation): string[] {
  if (!money) return [`${label}: amount missing`];
  const problems: string[] = [];
  if (money.currencyCode !== exp.currency) {
    problems.push(`${label}: currency ${money.currencyCode} ≠ expected ${exp.currency}`);
  }
  const minor = toMinorUnits(money.value, exp.currency);
  if (minor === null) problems.push(`${label}: amount "${money.value}" is not a valid ${exp.currency} amount`);
  else if (minor !== exp.amountMinor) problems.push(`${label}: amount ${money.value} ≠ expected (minor units ${exp.amountMinor})`);
  return problems;
}

/** Checks that the order is the one created for this local record, with the expected content. */
export function orderIdentityProblems(order: GatewayOrder, exp: Expectation): string[] {
  const problems: string[] = [];
  if (order.id !== exp.paypalOrderId) problems.push(`order id ${order.id ?? "(missing)"} ≠ stored order id`);
  if (order.purchaseUnits.length !== 1) {
    problems.push(`expected exactly 1 purchase unit, got ${order.purchaseUnits.length}`);
    return problems;
  }
  const unit = order.purchaseUnits[0];
  if (unit.referenceId !== exp.localId) problems.push("purchase unit reference_id does not match local record");
  if (unit.customId !== exp.localId) problems.push("purchase unit custom_id does not match local record");
  problems.push(...moneyProblems("order", unit.amount, exp));
  if (!unit.payeeMerchantId) problems.push("payee merchant_id missing in PayPal order");
  else if (unit.payeeMerchantId !== exp.payeeMerchantId) problems.push("payee merchant_id ≠ expected test supplier");
  return problems;
}

export type PreCaptureState = "READY" | "NOT_APPROVED" | "ALREADY_COMPLETED" | "CLOSED" | "MISMATCH";

export function checkBeforeCapture(order: GatewayOrder, exp: Expectation): { state: PreCaptureState; problems: string[] } {
  const problems = orderIdentityProblems(order, exp);
  if (problems.length > 0) return { state: "MISMATCH", problems };
  switch (order.status) {
    case "APPROVED":
      return { state: "READY", problems };
    case "COMPLETED":
      return { state: "ALREADY_COMPLETED", problems };
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      return { state: "NOT_APPROVED", problems };
    case "VOIDED":
      return { state: "CLOSED", problems };
    default:
      return { state: "MISMATCH", problems: [`unexpected order status ${order.status ?? "(missing)"}`] };
  }
}

export type CaptureVerdict = "PAID" | "PENDING" | "NOT_CAPTURED" | "DECLINED" | "MISMATCH";

export interface CaptureVerification {
  verdict: CaptureVerdict;
  problems: string[];
  captureId?: string;
  captureStatus?: string;
  orderStatus?: string;
}

/**
 * Independent verification from a fresh GET of the order: local link, order status, exactly one
 * capture, capture status, amount, currency and payee. Only "PAID" with no problems counts.
 */
export function verifyCapturedOrder(order: GatewayOrder, exp: Expectation): CaptureVerification {
  const orderStatus = order.status;
  const problems = orderIdentityProblems(order, exp);
  if (problems.length > 0) return { verdict: "MISMATCH", problems, orderStatus };

  const captures = order.purchaseUnits[0].captures;
  if (captures.length === 0) {
    if (orderStatus === "APPROVED" || orderStatus === "CREATED" || orderStatus === "PAYER_ACTION_REQUIRED") {
      return { verdict: "NOT_CAPTURED", problems: [], orderStatus };
    }
    return { verdict: "MISMATCH", problems: [`order status ${orderStatus ?? "(missing)"} but no capture`], orderStatus };
  }
  if (captures.length > 1) {
    return { verdict: "MISMATCH", problems: [`expected exactly 1 capture, got ${captures.length}`], orderStatus };
  }

  const capture = captures[0];
  const base = { captureId: capture.id, captureStatus: capture.status, orderStatus };
  if (!capture.id) return { ...base, verdict: "MISMATCH", problems: ["capture id missing"] };
  if (exp.captureId && capture.id !== exp.captureId) {
    return { ...base, verdict: "MISMATCH", problems: ["capture id ≠ capture id returned by the capture call"] };
  }
  const amountProblems = moneyProblems("capture", capture.amount, exp);
  if (amountProblems.length > 0) return { ...base, verdict: "MISMATCH", problems: amountProblems };

  if (capture.status === "COMPLETED" && orderStatus === "COMPLETED") return { ...base, verdict: "PAID", problems: [] };
  if (capture.status === "PENDING") return { ...base, verdict: "PENDING", problems: [] };
  if (capture.status === "DECLINED" || capture.status === "FAILED") return { ...base, verdict: "DECLINED", problems: [] };
  return {
    ...base,
    verdict: "MISMATCH",
    problems: [`capture status ${capture.status ?? "(missing)"} with order status ${orderStatus ?? "(missing)"}`],
  };
}
