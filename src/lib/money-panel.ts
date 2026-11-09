// "Money" panel of the approval page (9 Nov). Pure: it only NAMES facts the server already decided. Two questions
// are kept apart so a paid payment is never shown as "Not determined — blocked":
//   1. recorded — a payment record that already exists (actual amount, status, environment; payee is always the fixed
//      Sandbox test merchant, never the supplier);
//   2. next — whether a new approval or payment can be made now, and for which amount.
// No rule, amount or payment decision is computed here: amounts come from the stored records / the server preview.

export type PayEnv = "MOCK" | "Sandbox";

export interface MoneyPanelFacts {
  /** The preview's proposed amount (null when anything blocks). */
  proposed: string | null;
  /** Amount of the Active approval of THIS version, if any. */
  approvedHere: string | null;
  /** PAID record of this version. */
  paidHere: { amount: string; env: PayEnv } | null;
  /** PAID record of another version of this request. */
  paidOther: { versionNumber: number; amount: string; env: PayEnv } | null;
  /** A record whose outcome is still open (neither PAID nor FAILED). */
  open: { status: string; amount: string; versionNumber: number; env: PayEnv } | null;
  /** 9 Nov (later): a FAILED record, shown only when there is no paid and no open record (display only). */
  failed?: { amount: string; versionNumber: number; env: PayEnv } | null;
}

export type MoneyRecorded =
  | { kind: "PAID_HERE"; amount: string; env: PayEnv }
  | { kind: "PAID_OTHER"; versionNumber: number; amount: string; env: PayEnv }
  | { kind: "OPEN"; status: string; amount: string; versionNumber: number; env: PayEnv }
  | { kind: "FAILED"; amount: string; versionNumber: number; env: PayEnv }
  | { kind: "NONE" };

/**
 * Heading of the "recorded" line (9 Nov, later). Only a PAID record (or no record at all: "… made: None") uses "Payment
 * already made"; an order that exists is NOT a payment. Groups follow the record statuses of
 * src/server/payments/types.ts (RECORD_STATUSES) — nothing here changes or infers a status.
 */
export type RecordedHeading = "MADE" | "IN_PROGRESS" | "OUTCOME_UNKNOWN" | "PENDING" | "NEEDS_REVIEW" | "FAILED" | "OTHER";
export function recordedHeading(r: MoneyRecorded): RecordedHeading {
  if (r.kind === "PAID_HERE" || r.kind === "PAID_OTHER" || r.kind === "NONE") return "MADE";
  if (r.kind === "FAILED") return "FAILED";
  switch (r.status) {
    case "NEW":
    case "ORDER_CREATING":
    case "ORDER_CREATED":
    case "CAPTURING":
      return "IN_PROGRESS";
    case "CAPTURE_UNKNOWN":
      return "OUTCOME_UNKNOWN";
    case "CAPTURE_PENDING":
      return "PENDING";
    case "NEEDS_REVIEW":
      return "NEEDS_REVIEW";
    default:
      return "OTHER"; // unknown status name: never shown as paid
  }
}

export type MoneyNext =
  | { kind: "NONE_PAID" }
  | { kind: "NONE_OPEN"; status: string }
  | { kind: "APPROVED"; amount: string }
  | { kind: "PROPOSED"; amount: string }
  | { kind: "NONE_BLOCKED" };

export function moneyPanelView(f: MoneyPanelFacts): { recorded: MoneyRecorded; next: MoneyNext } {
  const recorded: MoneyRecorded = f.paidHere
    ? { kind: "PAID_HERE", ...f.paidHere }
    : f.paidOther
      ? { kind: "PAID_OTHER", ...f.paidOther }
      : f.open
        ? { kind: "OPEN", ...f.open }
        : f.failed
          ? { kind: "FAILED", ...f.failed }
          : { kind: "NONE" };
  // One paid payment per request: once any version is paid, nothing new can be approved or paid.
  const next: MoneyNext =
    f.paidHere || f.paidOther
      ? { kind: "NONE_PAID" }
      : f.open
        ? { kind: "NONE_OPEN", status: f.open.status }
        : f.approvedHere
          ? { kind: "APPROVED", amount: f.approvedHere }
          : f.proposed
            ? { kind: "PROPOSED", amount: f.proposed }
            : { kind: "NONE_BLOCKED" };
  return { recorded, next };
}
