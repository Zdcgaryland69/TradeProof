// Approval entry on the Quotes page (31 Oct). Pure: from the comparison choices of ONE selected quote version (the
// same list the approval page uses) and the viewer's role, decide what the entry shows. It never picks another version
// and always names the extraction run in the link, so the approval page never chooses one silently. Without a usable
// run there is no preview link — only the reasons, and a link to the approval history of that version.

export type EntryRefusal = string;

export interface EntryRun {
  id: string;
  mode: string;
  model: string;
  startedAt: string;
  refusal: EntryRefusal | null;
}

export interface EntryChoices {
  version: { id: string; versionNumber: number; latestVersionNumber: number; contentKind: string };
  runs: EntryRun[];
  base: null | { versionId: string; versionNumber: number; runs: EntryRun[] };
}

/** APPROVER = assigned approver of this request (may approve); OWNER = the owning buyer (sees status, never approves). */
export type EntryRole = "APPROVER" | "OWNER";

export type ApprovalEntry =
  | {
      kind: "NO_USABLE_RUN";
      role: EntryRole;
      versionNumber: number;
      latestVersionNumber: number;
      /** One line per stored run of this version and why it cannot be the basis; empty = no run stored. */
      refused: { runId: string; refusal: EntryRefusal }[];
      historyHref: string;
      approverAssigned: boolean | null;
    }
  | {
      kind: "PREVIEW";
      role: EntryRole;
      versionNumber: number;
      latestVersionNumber: number;
      run: EntryRun;
      /** Other usable runs of this version the viewer may name instead (newest first). */
      otherRuns: EntryRun[];
      /** Supplement only: the base version's run used for inherited terms; null with `baseMissing` = none usable. */
      baseRun: EntryRun | null;
      baseVersionNumber: number | null;
      baseMissing: boolean;
      href: string;
      approverAssigned: boolean | null;
    };

export function approvalHref(requestId: string, seriesId: string, versionId: string, runId: string | null, baseRunId: string | null): string {
  const q = new URLSearchParams({ series: seriesId, version: versionId });
  if (runId) q.set("run", runId);
  if (baseRunId) q.set("baseRun", baseRunId);
  return `/procurements/${requestId}/quotes/approval?${q.toString()}`;
}

/**
 * `chosenRunId` names a run the viewer picked; it is used only if it is a usable run of THIS version (else the newest
 * usable one — the same rule as the approval page — and the link shows which). `approverAssigned` is known to the owner
 * only (null for the approver, who is assigned by definition).
 */
export function approvalEntry(
  ids: { requestId: string; seriesId: string; versionId: string },
  choices: EntryChoices,
  role: EntryRole,
  approverAssigned: boolean | null,
  chosenRunId: string | null = null,
): ApprovalEntry {
  if (choices.version.id !== ids.versionId) throw new Error("choices belong to another quote version");
  const v = { versionNumber: choices.version.versionNumber, latestVersionNumber: choices.version.latestVersionNumber };
  const usable = choices.runs.filter((r) => r.refusal === null);
  if (usable.length === 0) {
    return {
      kind: "NO_USABLE_RUN",
      role,
      ...v,
      refused: choices.runs.map((r) => ({ runId: r.id, refusal: r.refusal as EntryRefusal })),
      historyHref: approvalHref(ids.requestId, ids.seriesId, ids.versionId, null, null),
      approverAssigned,
    };
  }
  const run = usable.find((r) => r.id === chosenRunId) ?? usable[0];
  const isSupplement = choices.version.contentKind === "SUPPLEMENT";
  const baseRun = isSupplement && choices.base ? (choices.base.runs.find((r) => r.refusal === null) ?? null) : null;
  return {
    kind: "PREVIEW",
    role,
    ...v,
    run,
    otherRuns: usable.filter((r) => r.id !== run.id),
    baseRun,
    baseVersionNumber: isSupplement ? (choices.base?.versionNumber ?? null) : null,
    baseMissing: isSupplement && baseRun === null,
    href: approvalHref(ids.requestId, ids.seriesId, ids.versionId, run.id, baseRun?.id ?? null),
    approverAssigned,
  };
}

// ---------- 5 Nov: decision summary (display only) ----------
//
// Maps facts the SERVER already decided — the preview status and finding levels, each approval's stored validity and
// the stored payment status — to the three status cells and one next step for the viewer. It evaluates no rule: it never
// decides whether something is blocked, approvable or payable; it only names what the server said, so "not checked",
// "blocked", "needs confirmation", "approved" and "paid" stay separate facts.

export type FindingLevel = "BLOCK" | "CONFIRM" | "INFO";
export interface DecisionFinding {
  level: FindingLevel;
  code: string;
}
export interface DecisionApproval {
  id: string;
  state: "ACTIVE" | "INVALIDATED" | "REVOKED";
  createdAt: string;
  versionNumber: number;
  versionId: string;
  seriesId: string;
  runId: string;
  amountMinor: number;
  currency: string;
  payment: null | { status: string; sku: string; amountMinor: number; currency: string; paidAt: string | null };
}
export interface DecisionFacts {
  role: EntryRole;
  /** Owner only: is an approver assigned now (null for the approver). */
  approverAssigned: boolean | null;
  versionNumber: number;
  latestVersionNumber: number;
  /** null = no usable run (nothing to check); "loading" / "error" while the preview is read. */
  evaluation: null | "loading" | "error" | { status: "BLOCKED" | "READY" | "READY_WITH_CONFIRMATIONS"; findings: DecisionFinding[] };
  /** Approvals of THIS version and Active approvals of other versions, from GET ?statusFor (read-only). */
  approvals: "loading" | "error" | { here: DecisionApproval[]; otherActive: DecisionApproval[] };
}

/**
 * PAID_NO_NEW_APPROVAL (5 Nov, owner): the server's ONLY blocking finding is ALREADY_PAID and THIS version's own approval
 * has a PAID payment record — i.e. a new approval is blocked because this version is paid, not because anything failed.
 * Any other blocking finding keeps the plain BLOCKED cell.
 */
export type CheckCell = { kind: "NOT_CHECKED" | "LOADING" | "ERROR" | "READY" | "PAID_NO_NEW_APPROVAL" } | { kind: "BLOCKED" | "READY_WITH_CONFIRMATIONS"; count: number };
export type ApprovalCell = { kind: "LOADING" | "ERROR" | "NONE" } | { kind: "ACTIVE" | "INVALIDATED" | "REVOKED"; approval: DecisionApproval } | { kind: "OTHER"; versions: number[]; approval: DecisionApproval };
export type PaymentCell = { kind: "LOADING" | "NONE" } | { kind: "PAID" | "OPEN" | "FAILED"; status: string; sku: string } | { kind: "OTHER"; versions: number[] };
export type NextKey =
  | "OWNER_NO_RUN"
  | "OWNER_OLDER"
  | "OWNER_BLOCKED"
  | "OWNER_NO_APPROVER"
  | "OWNER_WAITING"
  | "OWNER_PAY"
  | "OWNER_PAY_OPEN"
  | "OWNER_PAID"
  | "OWNER_OTHER_ACTIVE"
  | "APPROVER_NO_RUN"
  | "APPROVER_OLDER"
  | "APPROVER_BLOCKED"
  | "APPROVER_REVIEW"
  | "APPROVER_DONE"
  | "APPROVER_OTHER_ACTIVE";
export type NextAction = "clarify" | "request" | "assign" | "approve" | "pay" | "payment" | "latest" | "extraction" | "otherVersion";
export interface Decision {
  check: CheckCell;
  approval: ApprovalCell;
  payment: PaymentCell;
  /** null while facts are loading or unreadable (nothing is guessed). */
  next: null | { key: NextKey; primary: NextAction | null; secondary: NextAction | null };
}

const PAID = new Set(["PAID"]);
const ENDED_UNPAID = new Set(["FAILED"]);

export function decisionView(f: DecisionFacts): Decision {
  const ev = f.evaluation;
  let check: CheckCell =
    ev === null
      ? { kind: "NOT_CHECKED" }
      : ev === "loading"
        ? { kind: "LOADING" }
        : ev === "error"
          ? { kind: "ERROR" }
          : ev.status === "BLOCKED"
            ? { kind: "BLOCKED", count: ev.findings.filter((x) => x.level === "BLOCK").length }
            : ev.status === "READY_WITH_CONFIRMATIONS"
              ? { kind: "READY_WITH_CONFIRMATIONS", count: ev.findings.filter((x) => x.level === "CONFIRM").length }
              : { kind: "READY" };

  let approval: ApprovalCell;
  let payment: PaymentCell;
  if (f.approvals === "loading" || f.approvals === "error") {
    approval = { kind: f.approvals === "loading" ? "LOADING" : "ERROR" };
    payment = { kind: "LOADING" };
  } else {
    const { here, otherActive } = f.approvals;
    const active = here.find((a) => a.state === "ACTIVE") ?? null;
    const latest = active ?? [...here].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    const otherVersions = [...new Set(otherActive.map((a) => a.versionNumber))].sort((a, b) => a - b);
    if (active) approval = { kind: "ACTIVE", approval: active };
    else if (otherActive.length > 0) approval = { kind: "OTHER", versions: otherVersions, approval: otherActive[0] };
    else if (latest) approval = { kind: latest.state as "INVALIDATED" | "REVOKED", approval: latest };
    else approval = { kind: "NONE" };
    // Payment of THIS version's approvals only; a paid other version is named as such, never as this one's.
    const pays = here.map((a) => a.payment).filter((p): p is NonNullable<DecisionApproval["payment"]> => p !== null);
    const paid = pays.find((p) => PAID.has(p.status)) ?? null;
    const open = pays.find((p) => !PAID.has(p.status) && !ENDED_UNPAID.has(p.status)) ?? null;
    const failed = pays.find((p) => ENDED_UNPAID.has(p.status)) ?? null;
    const otherPaid = otherActive.filter((a) => a.payment && PAID.has(a.payment.status)).map((a) => a.versionNumber);
    payment = paid
      ? { kind: "PAID", status: paid.status, sku: paid.sku }
      : open
        ? { kind: "OPEN", status: open.status, sku: open.sku }
        : otherPaid.length > 0
          ? { kind: "OTHER", versions: [...new Set(otherPaid)] }
          : failed
            ? { kind: "FAILED", status: failed.status, sku: failed.sku }
            : { kind: "NONE" };
  }

  if (check.kind === "BLOCKED" && payment.kind === "PAID" && ev && typeof ev === "object") {
    const blocks = ev.findings.filter((x) => x.level === "BLOCK");
    if (blocks.length > 0 && blocks.every((x) => x.code === "ALREADY_PAID")) check = { kind: "PAID_NO_NEW_APPROVAL" };
  }
  const known = check.kind !== "LOADING" && check.kind !== "ERROR" && approval.kind !== "LOADING" && approval.kind !== "ERROR";
  if (!known) return { check, approval, payment, next: null };
  const older = f.versionNumber < f.latestVersionNumber;
  const n = (key: NextKey, primary: NextAction | null = null, secondary: NextAction | null = null) => ({ key, primary, secondary });
  let next: Decision["next"];
  if (f.role === "OWNER") {
    if (payment.kind === "PAID") next = n("OWNER_PAID", "payment");
    else if (approval.kind === "ACTIVE") next = payment.kind === "OPEN" ? n("OWNER_PAY_OPEN", "pay") : n("OWNER_PAY", "pay");
    else if (approval.kind === "OTHER") next = n("OWNER_OTHER_ACTIVE", "otherVersion");
    else if (check.kind === "NOT_CHECKED") next = n("OWNER_NO_RUN", "extraction");
    else if (older) next = n("OWNER_OLDER", "latest");
    else if (check.kind === "BLOCKED") next = n("OWNER_BLOCKED", "clarify", "request");
    else if (f.approverAssigned === false) next = n("OWNER_NO_APPROVER", "assign");
    else next = n("OWNER_WAITING");
  } else {
    if (approval.kind === "ACTIVE") next = n("APPROVER_DONE");
    else if (approval.kind === "OTHER") next = n("APPROVER_OTHER_ACTIVE", "otherVersion");
    else if (check.kind === "NOT_CHECKED") next = n("APPROVER_NO_RUN");
    else if (older) next = n("APPROVER_OLDER", "latest");
    else if (check.kind === "BLOCKED") next = n("APPROVER_BLOCKED");
    else next = n("APPROVER_REVIEW", "approve");
  }
  return { check, approval, payment, next };
}
