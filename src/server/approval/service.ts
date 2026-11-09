// Approval of the latest complete conditions of a quote series (29 Oct; design docs/approval-design.md).
//
// - preview: computed on the server from stored records (quote text hash re-computed, the run(s), their reviews, the
//   comparison re-run here, buyer statements, classifications, earlier payments). Nothing is stored.
// - approve: inside ONE write transaction the preview is computed again; it must have no BLOCK, its digest must equal
//   the digest the user saw and the confirmations must be exactly its CONFIRM keys; then one immutable row is written.
// - validity: derived from append-only records written AFTER the approval (request revisions, reviews, quote versions,
//   statements / links, classifications), the payee and the rules. The first problem found writes a terminal
//   INVALIDATED event; nothing ever makes an approval valid again.
// - payment: amount and currency come from the approval row only; create-order and capture are guarded by the
//   validity check inside the payment state change (PaymentService), PayPal is called after commit. Reads of PayPal
//   are never blocked; a sent or unknown payment keeps its real state.
// The local developer is the only principal today: every approval says "not signed in, no separation of duties".

import { randomUUID } from "node:crypto";
import { compareExtraction, runRefusal, type VersionFacts } from "../../lib/comparison.ts";
import type { ExtractionRun } from "../../lib/extraction.ts";
import { IDEMPOTENCY_KEY } from "../../lib/quote-versions.ts";
import { shortProcurementId } from "../../lib/procurement.ts";
import { shortSeriesId } from "../../lib/quote-versions.ts";
import { actorOf, canApproveRequest, canPayRequest, canReadRequest, canRevokeApproval, canWriteRequest, storedActorLabel, type Principal } from "../access/policy.ts";
import type { ClarificationStore } from "../clarification/store.ts";
import { facts, singaporeDay } from "../comparison/service.ts";
import type { ExtractionStore, VersionInput } from "../extraction/store.ts";
import type { PaymentService, ServiceResult } from "../payments/service.ts";
import type { ProcurementStore } from "../procurement/store.ts";
import type { ReplyService } from "../replies/service.ts";
import type { ReplyStore } from "../replies/store.ts";
import {
  canonicalJson,
  classificationsDigest,
  evaluateApproval,
  requestFingerprint,
  reviewsDigest,
  rulesKey,
  sha256,
  statementsDigest,
  type Classification,
  type Evaluation,
  type EvaluationInput,
  type SeriesStatement,
  type VersionBasis,
} from "./evaluate.ts";
import type { ApprovalEvent, ApprovalStore, LinkedPayment, StoredApproval } from "./store.ts";

type AnyPrincipal = Principal;

export interface Ids {
  seriesId: string;
  versionId: string;
  runId: string;
  baseRunId: string | null;
}

export type PreviewOutcome = { status: "NOT_FOUND" } | { status: "OK"; evaluation: Evaluation; ids: Ids };

export type ApproveOutcome =
  | { status: "NOT_FOUND" }
  | { status: "INVALID"; message: string }
  | { status: "KEY_REUSED" }
  | { status: "FORBIDDEN" }
  | { status: "BLOCKED"; evaluation: Evaluation }
  | { status: "BASIS_CHANGED"; evaluation: Evaluation }
  | { status: "CONFIRMATIONS_MISMATCH"; evaluation: Evaluation; missing: string[]; unexpected: string[] }
  | { status: "ALREADY_APPROVED"; approval: StoredApproval }
  | { status: "CREATED" | "REPLAYED" | "EXISTING"; approval: StoredApproval };

export interface Validity {
  state: "ACTIVE" | "INVALIDATED" | "REVOKED";
  reasons: string[];
  since: string | null;
}

export interface ApprovalView {
  approval: StoredApproval;
  validity: Validity;
  events: ApprovalEvent[];
  payments: LinkedPayment[];
  actorLabel: string;
}

/** Read-only approval facts (no event, audit or payment written while reading). */
export interface ApprovalFacts {
  evaluation: Evaluation | null;
  approvals: { approval: StoredApproval; validity: Validity; payments: LinkedPayment[]; actorLabel: string }[];
  payee: { configured: boolean; fingerprint: string | null };
}

export type PaymentOutcome =
  | { status: "NOT_FOUND" }
  | { status: "APPROVAL_INVALID"; validity: Validity }
  | { status: "ALREADY_PAID" | "PAYMENT_OUTCOME_OPEN"; recordId: string }
  | { status: "NO_PAYMENT" }
  | { status: "NOT_PAYABLE"; reason: string }
  | { status: "CREATED" | "EXISTING"; payment: LinkedPayment }
  | { status: "PAYPAL"; result: ServiceResult };

export interface ApprovalServiceDeps {
  store: ApprovalStore;
  extraction: ExtractionStore;
  procurement: ProcurementStore;
  replies: ReplyService;
  replyStore: ReplyStore;
  drafts: ClarificationStore;
  /** Created lazily: PayPal configuration is read only when a payment step runs. */
  payments: () => PaymentService;
  /** The configured Sandbox payee (fixed; never from a quote or the browser). */
  payee: () => { configured: boolean; merchantId: string | null };
  /** SKU and item-name suffix of new payment records (MOCK records are labelled as such). Default: Sandbox. */
  paymentLabel?: () => { sku: string; suffix: string };
  /** Display name of an account id (for stored actors); absent in tests that do not need it. */
  accountName?: (id: string) => string | null;
  now?: () => Date;
}

const FAIL_FREE_STATUSES = new Set(["FAILED"]);
const BODY_KEYS = new Set(["seriesId", "versionId", "runId", "baseRunId", "previewDigest", "confirmed"]);
const CLASSIFY_KEYS = new Set(["subject", "decision", "reason", "excerpt", "replaces"]);
const RUN_ID = /^qx_[0-9a-f-]{36}$/;
const SERIES_ID = /^qs_[0-9a-f-]{36}$/;
const VERSION_ID = /^qv_[0-9a-f-]{36}$/;

export const payeeFingerprint = (merchantId: string | null) => (merchantId ? sha256(`sandbox-payee\n${merchantId}`) : null);

function basis(input: VersionInput, f: VersionFacts): VersionBasis {
  return {
    id: input.versionId,
    seriesId: input.seriesId,
    versionNumber: input.versionNumber,
    contentKind: input.contentKind,
    supplementsVersionId: input.context?.versionId ?? null,
    rawText: input.rawText,
    rawTextSha256: input.rawTextSha256,
    computedSha256: f.computedSha256,
    requestRevision: input.requestRevision,
    snapshotRecord: input.snapshot.record,
  };
}

export class ApprovalService {
  private readonly d: ApprovalServiceDeps;
  private readonly now: () => Date;

  constructor(deps: ApprovalServiceDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- inputs ----------

  private statements(principal: AnyPrincipal, requestId: string, seriesId: string): SeriesStatement[] {
    const all = this.d.replies.buyerStatements(principal as Principal, requestId) ?? [];
    const links = new Map(this.d.replyStore.seriesReplies(seriesId).map((r) => [r.id, r.updatedQuotes.map((u) => u.id)] as const));
    return all
      .filter((s) => this.d.drafts.get(s.draftId)?.seriesId === seriesId)
      .map((s) => ({
        answerId: s.answerId,
        draftId: s.draftId,
        number: s.number,
        field: s.field,
        requestItemId: s.requestItemId,
        itemName: s.itemName,
        statement: s.statement,
        kind: s.statementKind,
        quoteUpdate: s.quoteUpdate,
        supplierReplyId: s.supplierReplyId,
        contradicted: s.contradicted,
        basisChanges: [...s.basisChanges],
        linkedVersionIds: links.get(s.supplierReplyId) ?? [],
      }));
  }

  private payee(): { configured: boolean; fingerprint: string | null } {
    const p = this.d.payee();
    return { configured: p.configured && !!p.merchantId, fingerprint: payeeFingerprint(p.merchantId) };
  }

  /** Everything the gate needs, read now from stored records. null = not this request's data. */
  private gather(principal: AnyPrincipal, requestId: string, ids: Ids): EvaluationInput | null {
    const request = this.d.procurement.get(requestId);
    const input = this.d.extraction.versionInput(requestId, ids.seriesId, ids.versionId);
    const run = this.d.extraction.getRun(ids.runId);
    if (!request || !input || !run || run.requestId !== requestId) return null;
    const version = facts(input);
    let refusal: string | null = runRefusal(run, version);
    let baseInput: VersionInput | null = null;
    let baseRun: ExtractionRun | null = null;
    if (input.contentKind === "SUPPLEMENT" && input.context) baseInput = this.d.extraction.versionInput(requestId, ids.seriesId, input.context.versionId);
    const baseFacts = baseInput ? facts(baseInput) : null;
    if (ids.baseRunId !== null) {
      const candidate = this.d.extraction.getRun(ids.baseRunId);
      if (!candidate || candidate.requestId !== requestId) return null;
      if (!baseFacts) refusal ??= "BASE_RUN_NOT_APPLICABLE";
      else if (candidate.versionId !== baseFacts.id) refusal ??= "BASE_RUN_NOT_FOR_BASE_VERSION";
      else if (baseFacts.contentKind !== "FULL_QUOTE" || runRefusal(candidate, baseFacts) !== null) refusal ??= "BASE_RUN_NOT_USABLE";
      else baseRun = candidate;
    }
    const reviews = this.d.extraction.reviews(run.id);
    const baseReviews = baseRun ? this.d.extraction.reviews(baseRun.id) : [];
    const asOf = singaporeDay(this.now());
    const comparison =
      refusal === null
        ? compareExtraction({
            version,
            run,
            reviews,
            currentRequestRevision: request.revision,
            base: baseFacts ? { version: baseFacts, run: baseRun, reviews: baseReviews } : null,
            asOf,
          })
        : null;
    const p = this.d.payee();
    return {
      request,
      version: basis(input, version),
      base: baseInput && baseFacts ? basis(baseInput, baseFacts) : null,
      seriesVersions: this.d.store.seriesVersions(ids.seriesId),
      run,
      baseRun,
      reviews,
      baseReviews,
      comparison,
      refusal,
      statements: this.statements(principal, requestId, ids.seriesId),
      classifications: this.d.store.classifications(ids.versionId),
      priorPayments: this.d.store.paymentsForRequest(requestId),
      payee: { configured: p.configured && !!p.merchantId, fingerprint: payeeFingerprint(p.merchantId) },
      asOf,
    };
  }

  // ---------- preview / approve ----------

  /** Read-only preview: the owning buyer and an assigned approver may see it; only the approver may approve it. */
  preview(principal: AnyPrincipal, requestId: string, ids: Ids): PreviewOutcome {
    if (!canReadRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const input = this.gather(principal, requestId, ids);
    return input ? { status: "OK", evaluation: evaluateApproval(input), ids } : { status: "NOT_FOUND" };
  }

  approve(principal: AnyPrincipal, requestId: string, body: Record<string, unknown>, key: string): ApproveOutcome {
    if (!canApproveRequest(principal, requestId)) {
      if (canReadRequest(principal, requestId)) this.auditBestEffort(principal, "APPROVE", requestId, "DENIED", { reason: "NOT_AN_ASSIGNED_APPROVER" });
      return canReadRequest(principal, requestId) ? { status: "FORBIDDEN" } : { status: "NOT_FOUND" };
    }
    if (!IDEMPOTENCY_KEY.test(key)) return { status: "INVALID", message: "A request key (UUID) is required." };
    const unknown = Object.keys(body).filter((k) => !BODY_KEYS.has(k));
    if (unknown.length > 0) return { status: "INVALID", message: `Unknown field(s): ${unknown.join(", ")}. Amount, currency, payee and terms are read by the server, never sent.` };
    const { seriesId, versionId, runId, baseRunId, previewDigest, confirmed } = body as Record<string, unknown>;
    if (typeof seriesId !== "string" || !SERIES_ID.test(seriesId) || typeof versionId !== "string" || !VERSION_ID.test(versionId) || typeof runId !== "string" || !RUN_ID.test(runId)) {
      return { status: "INVALID", message: "seriesId, versionId and runId are required ids." };
    }
    if (baseRunId !== null && baseRunId !== undefined && (typeof baseRunId !== "string" || !RUN_ID.test(baseRunId))) return { status: "INVALID", message: "baseRunId must be a run id or null." };
    if (typeof previewDigest !== "string" || !/^[0-9a-f]{64}$/.test(previewDigest)) return { status: "INVALID", message: "previewDigest (from the preview) is required." };
    if (!Array.isArray(confirmed) || confirmed.some((k) => typeof k !== "string" || k.length > 200) || new Set(confirmed).size !== confirmed.length) {
      return { status: "INVALID", message: "confirmed must be a list of distinct confirmation keys." };
    }
    const ids: Ids = { seriesId, versionId, runId, baseRunId: (baseRunId as string | null | undefined) ?? null };
    const fingerprint = sha256(canonicalJson({ requestId, ...ids, previewDigest, confirmed: [...(confirmed as string[])].sort() }));
    const actor = actorOf(principal);

    const out = this.d.store.transaction((): ApproveOutcome => {
      const replay = this.d.store.approvalByKey(key);
      if (replay) return replay.fingerprint === fingerprint && replay.requestId === requestId && replay.actor.id === actor.id ? { status: "REPLAYED", approval: replay } : { status: "KEY_REUSED" };
      // The grant is re-read inside the write lock: a revoke committed before this point stops the approval.
      // v17: the grant this approval is made under, read through this connection inside the lock and stored with it.
      const grant = actor.kind === "APPROVER" && actor.id ? this.d.store.latestGrant(requestId, actor.id) : null;
      if (!canApproveRequest(principal, requestId) || grant?.action !== "GRANT") {
        this.auditInTx(principal, "APPROVE", requestId, "DENIED", { reason: "GRANT_REVOKED_BEFORE_COMMIT" });
        return { status: "FORBIDDEN" };
      }
      // Re-check everything inside the write lock: no other writer can commit until this transaction ends.
      const input = this.gather(principal, requestId, ids);
      if (!input) return { status: "NOT_FOUND" };
      const evaluation = evaluateApproval(input);
      if (evaluation.status === "BLOCKED") return { status: "BLOCKED", evaluation };
      if (evaluation.digest !== previewDigest) return { status: "BASIS_CHANGED", evaluation };
      const given = new Set(confirmed as string[]);
      const expected = new Set(evaluation.confirmKeys);
      const missing = [...expected].filter((k) => !given.has(k));
      const unexpected = [...given].filter((k) => !expected.has(k));
      if (missing.length > 0 || unexpected.length > 0) return { status: "CONFIRMATIONS_MISMATCH", evaluation, missing, unexpected };
      for (const a of this.d.store.approvalsFor(requestId)) {
        if (this.validity(principal, a, true).state !== "ACTIVE") continue;
        return a.previewDigest === evaluation.digest ? { status: "EXISTING", approval: a } : { status: "ALREADY_APPROVED", approval: a };
      }
      const s = evaluation.snapshot;
      const approval = this.d.store.insertApproval({
        requestId,
        seriesId: ids.seriesId,
        versionId: ids.versionId,
        baseVersionId: s.quote.base?.versionId ?? null,
        runId: ids.runId,
        baseRunId: input.baseRun?.id ?? null,
        requestRevision: s.request.revision,
        requestFingerprint: s.request.fingerprint,
        latestVersionNumber: s.quote.latestVersionNumber,
        reviewsDigest: s.digests.reviews,
        statementsDigest: s.digests.statements,
        classificationsDigest: s.digests.classifications,
        payeeFingerprint: s.payee.fingerprint!,
        rules: rulesKey(),
        amountMinor: evaluation.amount!.minor,
        currency: evaluation.amount!.currency,
        snapshot: s,
        previewDigest: evaluation.digest,
        confirmed: [...(confirmed as string[])].sort(),
        actor: { kind: actor.kind, id: actor.id, authenticated: actor.authenticated },
        approverGrantSeq: grant.seq,
        idempotencyKey: key,
        fingerprint,
      });
      // The audit row commits with the approval (same connection, same transaction): an approval is never stored
      // without it, and a failing audit write rolls the approval back (reported as not saved; a retry with the same
      // key then creates it once).
      this.auditInTx(principal, "APPROVE", requestId, "OK", { approval: approval.id, digest: approval.previewDigest.slice(0, 16) });
      return { status: "CREATED", approval };
    });
    return out;
  }

  /** Audit row inside the caller's approval-store transaction (atomic with the decision). */
  private auditInTx(principal: AnyPrincipal, action: string, requestId: string, outcome: "OK" | "DENIED" | "FAILED", detail: Record<string, unknown> = {}): void {
    this.d.store.audit({ actorId: principal.id, actorRole: principal.kind, action, objectType: "REQUEST", objectId: requestId, outcome, detail });
  }

  /**
   * Audit row for a refusal that wrote nothing (no transaction to join) or for a payment step after its PayPal call.
   * A failure here must not turn a correct answer into an error, but it is not silent: it is logged on the server.
   */
  private auditBestEffort(principal: AnyPrincipal, action: string, requestId: string, outcome: "OK" | "DENIED" | "FAILED", detail: Record<string, unknown> = {}): void {
    try {
      this.d.store.audit({ actorId: principal.id, actorRole: principal.kind, action, objectType: "REQUEST", objectId: requestId, outcome, detail });
    } catch (err) {
      console.error(`[audit] could not write ${action} ${outcome} for ${requestId} by ${principal.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Why this approval cannot pay, apart from validity: approvals made before sign-in existed (local developer, not
   * authenticated) are history only and never authorise a payment.
   */
  private notPayable(a: StoredApproval): string | null {
    return a.actor.kind === "APPROVER" && a.actor.authenticated && a.actor.id ? null : "LEGACY_UNAUTHENTICATED_APPROVAL";
  }

  // ---------- validity ----------

  /**
   * Problems found in append-only records written after the approval (read-only). A later revert never removes the
   * record of the change, so an approval that once had a problem keeps it.
   */
  validityProblems(principal: AnyPrincipal, a: StoredApproval): string[] {
    const problems: string[] = [];
    for (const r of this.d.store.revisionsAfter(a.requestId, a.requestRevision)) {
      if (requestFingerprint(r.record) !== a.requestFingerprint) problems.push(`REQUEST_REVISED:r${r.revision}`);
    }
    const reviewIds = this.d.store.reviewIds([a.runId, ...(a.baseRunId ? [a.baseRunId] : [])]);
    if (reviewsDigest(reviewIds.map((id) => ({ id }) as never)) !== a.reviewsDigest) problems.push("REVIEWS_CHANGED");
    const latest = Math.max(0, ...this.d.store.seriesVersions(a.seriesId).map((v) => v.versionNumber));
    if (latest > a.latestVersionNumber) problems.push(`NEWER_QUOTE_VERSION:v${latest}`);
    if (statementsDigest(this.statements(principal, a.requestId, a.seriesId)) !== a.statementsDigest) problems.push("STATEMENTS_CHANGED");
    if (classificationsDigest(this.d.store.classifications(a.versionId) as Classification[]) !== a.classificationsDigest) problems.push("CLASSIFICATIONS_CHANGED");
    if (this.payee().fingerprint !== a.payeeFingerprint) problems.push("PAYEE_CHANGED");
    if (rulesKey() !== a.rules) problems.push("RULES_CHANGED");
    // The approving approver's assignment (v17: by grant sequence, never by time). Approvals by the old unauthenticated
    // local developer have no approver id and are refused for payment separately (notPayable).
    problems.push(...this.assignmentProblems(a));
    for (const [id, hash] of [[a.versionId, a.snapshot.quote.rawTextSha256], ...(a.snapshot.quote.base ? [[a.snapshot.quote.base.versionId, a.snapshot.quote.base.rawTextSha256]] : [])]) {
      const t = this.d.store.versionText(id);
      if (!t || sha256(t.rawText) !== hash || t.rawTextSha256 !== hash) problems.push("QUOTE_TEXT_CHANGED");
    }
    return problems;
  }

  /**
   * The approver's assignment behind an approval, from append-only grant rows ordered by `seq` (R-ACCESS-CLOCK, 31 Oct):
   * - APPROVER_UNASSIGNED: a REVOKE after the grant the approval was made under (a later re-grant does not restore it),
   *   or the approver is not assigned now;
   * - GRANT_BASIS_UNKNOWN: an approver's approval from before v17 — the grant it was made under is not recorded, so it
   *   never authorises a payment; a new approval is needed (nothing is inferred from timestamps).
   */
  private assignmentProblems(a: StoredApproval): string[] {
    if (a.actor.kind !== "APPROVER" || !a.actor.id) return [];
    const assignedNow = this.d.store.latestGrant(a.requestId, a.actor.id)?.action === "GRANT";
    if (a.approverGrantSeq === null) return assignedNow ? ["GRANT_BASIS_UNKNOWN"] : ["GRANT_BASIS_UNKNOWN", "APPROVER_UNASSIGNED"];
    return !assignedNow || this.d.store.revokedAfter(a.requestId, a.actor.id, a.approverGrantSeq) ? ["APPROVER_UNASSIGNED"] : [];
  }

  /** Current validity. With `record`, the first problem found is written as a terminal INVALIDATED event. */
  validity(principal: AnyPrincipal, a: StoredApproval, record: boolean): Validity {
    const events = this.d.store.events(a.id);
    const terminal = events.find((e) => e.kind === "REVOKED" || e.kind === "INVALIDATED");
    if (terminal) return { state: terminal.kind === "REVOKED" ? "REVOKED" : "INVALIDATED", reasons: terminal.reasons, since: terminal.createdAt };
    const problems = this.validityProblems(principal, a);
    if (problems.length === 0) return { state: "ACTIVE", reasons: [], since: null };
    if (record) this.d.store.addEvent(a.id, "INVALIDATED", problems, null, null, null);
    return { state: "INVALIDATED", reasons: problems, since: record ? this.d.store.events(a.id)[0]?.createdAt ?? null : null };
  }

  private recordInvalidation(principal: AnyPrincipal, a: StoredApproval): Validity {
    return this.d.store.transaction(() => this.validity(principal, a, true));
  }

  private owned(principal: AnyPrincipal, requestId: string, approvalId: string): StoredApproval | null {
    const a = this.d.store.approval(approvalId);
    return a && a.requestId === requestId && canReadRequest(principal, requestId) ? a : null;
  }

  view(principal: AnyPrincipal, requestId: string, approvalId: string): ApprovalView | null {
    const a = this.owned(principal, requestId, approvalId);
    if (!a) return null;
    const validity = this.recordInvalidation(principal, a);
    return { approval: a, validity, events: this.d.store.events(a.id), payments: this.d.store.payments(a.id), actorLabel: storedActorLabel(a.actor.kind, a.actor.id, a.actor.id ? this.d.accountName?.(a.actor.id) : null) };
  }

  /**
   * Read-only facts for the Copilot (2 Nov, gap G2). Same access rule as `preview` / `list`, but validity is COMPUTED
   * (`validity(…, false)`): unlike `view` / `list`, this never writes an INVALIDATED event, an audit row or anything
   * else. `ids` null → no gate evaluation (no usable run), approvals only. null = not readable or not existing.
   */
  readFacts(principal: AnyPrincipal, requestId: string, ids: Ids | null): ApprovalFacts | null {
    if (!canReadRequest(principal, requestId)) return null;
    if (!this.d.procurement.get(requestId)) return null;
    let evaluation: Evaluation | null = null;
    if (ids) {
      const input = this.gather(principal, requestId, ids);
      if (!input) return null;
      evaluation = evaluateApproval(input);
    }
    const approvals = this.d.store.approvalsFor(requestId).map((a) => ({
      approval: a,
      validity: this.validity(principal, a, false),
      payments: this.d.store.payments(a.id),
      actorLabel: storedActorLabel(a.actor.kind, a.actor.id, a.actor.id ? this.d.accountName?.(a.actor.id) : null),
    }));
    return { evaluation, approvals, payee: this.payee() };
  }

  list(principal: AnyPrincipal, requestId: string): ApprovalView[] | null {
    if (!canReadRequest(principal, requestId)) return null;
    return this.d.store.approvalsFor(requestId).map((a) => this.view(principal, requestId, a.id)!);
  }

  revoke(principal: AnyPrincipal, requestId: string, approvalId: string, note: unknown, key: string): { status: "NOT_FOUND" } | { status: "INVALID"; message: string } | { status: "REVOKED" | "ALREADY_ENDED"; view: ApprovalView } {
    if (!canRevokeApproval(principal, requestId)) return { status: "NOT_FOUND" };
    const a = this.owned(principal, requestId, approvalId);
    if (!a) return { status: "NOT_FOUND" };
    if (!IDEMPOTENCY_KEY.test(key)) return { status: "INVALID", message: "A request key (UUID) is required." };
    const text = typeof note === "string" ? note.trim() : "";
    if (text.length < 1 || text.length > 500) return { status: "INVALID", message: "A reason (1–500 characters) is required to revoke." };
    const outcome = this.d.store.transaction(() => {
      if (this.d.store.eventByKey(key)) return "ALREADY_ENDED" as const;
      const v = this.validity(principal, a, true);
      if (v.state !== "ACTIVE") return "ALREADY_ENDED" as const;
      this.d.store.addEvent(a.id, "REVOKED", ["REVOKED_BY_USER"], text, actorOf(principal).kind, key);
      this.auditInTx(principal, "APPROVAL_REVOKED", requestId, "OK", { approval: a.id });
      return "REVOKED" as const;
    });
    return { status: outcome, view: this.view(principal, requestId, approvalId)! };
  }

  // ---------- free-text requirement classification ----------

  /** 7 Nov: read-only classification history of one quote version (oldest first) for anyone who can read the request. */
  classificationHistory(principal: AnyPrincipal, requestId: string, versionId: string) {
    if (!canReadRequest(principal, requestId)) return null;
    return this.d.store.classificationHistory(versionId).filter((c) => c.subject === "ADDITIONAL_REQUIREMENTS" || c.subject.startsWith("ITEM_NOTES:"));
  }

  classify(principal: AnyPrincipal, requestId: string, seriesId: string, versionId: string, body: Record<string, unknown>, key: string):
    | { status: "NOT_FOUND" }
    | { status: "INVALID"; message: string }
    | { status: "KEY_REUSED" }
    | { status: "STALE"; current: Classification | null }
    | { status: "CREATED" | "REPLAYED" | "UNCHANGED"; classification: Classification } {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const input = this.d.extraction.versionInput(requestId, seriesId, versionId);
    if (!input) return { status: "NOT_FOUND" };
    if (!IDEMPOTENCY_KEY.test(key)) return { status: "INVALID", message: "A request key (UUID) is required." };
    const unknown = Object.keys(body).filter((k) => !CLASSIFY_KEYS.has(k));
    if (unknown.length > 0) return { status: "INVALID", message: `Unknown field(s): ${unknown.join(", ")}.` };
    const { subject, decision, reason, excerpt } = body;
    const record = input.snapshot.record;
    const text =
      subject === "ADDITIONAL_REQUIREMENTS"
        ? record.additionalRequirements
        : typeof subject === "string" && subject.startsWith("ITEM_NOTES:")
          ? (record.items.find((i) => `ITEM_NOTES:${i.id}` === subject)?.notes ?? null)
          : null;
    if (!text) return { status: "INVALID", message: "subject must name the additional requirements or an item's notes of this quote's request snapshot (non-empty)." };
    if (decision !== "NOT_KEY" && decision !== "KEY_IN_QUOTE" && decision !== "KEY_NOT_IN_QUOTE") return { status: "INVALID", message: "decision must be NOT_KEY, KEY_IN_QUOTE or KEY_NOT_IN_QUOTE." };
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 1 || why.length > 500) return { status: "INVALID", message: "A reason (1–500 characters) is required." };
    let quoted: string | null = null;
    let quotedIn: string | null = null;
    if (decision === "KEY_IN_QUOTE") {
      quoted = typeof excerpt === "string" ? excerpt.trim() : "";
      if (quoted.length < 1 || quoted.length > 2000) return { status: "INVALID", message: "KEY_IN_QUOTE needs a verbatim excerpt from the quote text." };
      if (input.rawText.includes(quoted)) quotedIn = input.versionId;
      else if (input.context && input.context.rawText.includes(quoted)) quotedIn = input.context.versionId;
      else return { status: "INVALID", message: "The excerpt does not occur in this quote version's text (or its base). Copy it exactly." };
    } else if (excerpt !== undefined && excerpt !== null && excerpt !== "") return { status: "INVALID", message: "An excerpt is only recorded for KEY_IN_QUOTE." };
    // 7 Nov: a re-classification must name the classification it replaces (the one the user saw). Classifications are
    // append-only and the latest wins, so without this a form left open in another tab could silently replace a later
    // correction. First classification: `replaces` absent / null. Checked inside the insert transaction.
    const replaces = body.replaces === undefined || body.replaces === null ? null : body.replaces;
    if (replaces !== null && (typeof replaces !== "string" || !/^rc_[0-9a-f-]{36}$/.test(replaces))) return { status: "INVALID", message: "replaces must be the id of the classification you are replacing." };
    // The fingerprint is unchanged for a first classification (no `replaces`), so replays of earlier saves still match.
    const fingerprint = sha256(canonicalJson({ requestId, versionId, subject, decision, reason: why, excerpt: quoted, ...(replaces ? { replaces } : {}) }));
    const textSha = sha256(text);
    return this.d.store.transaction(() => {
      const prior = this.d.store.classificationByKey(key);
      if (prior) return prior.fingerprint === fingerprint ? { status: "REPLAYED" as const, classification: prior } : { status: "KEY_REUSED" as const };
      const current = this.d.store.classifications(versionId).find((c) => c.subject === subject && c.textSha256 === textSha) ?? null;
      if ((current?.id ?? null) !== replaces) return { status: "STALE" as const, current };
      // Same decision, reason and excerpt as the current one: nothing to record (and no approval is invalidated).
      if (current && current.decision === decision && current.reason === why && current.excerpt === quoted) return { status: "UNCHANGED" as const, classification: current };
      const classification = this.d.store.insertClassification({ requestId, versionId, subject: subject as string, textSha256: textSha, decision, reason: why, excerpt: quoted, excerptVersionId: quotedIn, idempotencyKey: key, fingerprint });
      return { status: "CREATED" as const, classification };
    });
  }

  // ---------- payment (amount from the approval only) ----------

  /** Read-only: what a payment of this approval would be, and whether it may start now. Writes no payment. */
  paymentReadiness(principal: AnyPrincipal, requestId: string, approvalId: string) {
    if (!canPayRequest(principal, requestId)) return null;
    const v = this.view(principal, requestId, approvalId);
    if (!v) return null;
    const others = this.d.store.paymentsForRequest(requestId).filter((p) => p.approvalId !== approvalId);
    const blockers = [
      ...(v.validity.state !== "ACTIVE" ? [`APPROVAL_${v.validity.state}`] : []),
      ...(this.notPayable(v.approval) ? [this.notPayable(v.approval)!] : []),
      ...others.filter((p) => p.status === "PAID").map(() => "ALREADY_PAID"),
      ...others.filter((p) => !["PAID", "FAILED", "NEW", "ORDER_CREATED"].includes(p.status)).map(() => "PAYMENT_OUTCOME_OPEN"),
    ];
    return { amountMinor: v.approval.amountMinor, currency: v.approval.currency, payee: "FIXED_SANDBOX_TEST_MERCHANT" as const, blockers, payments: v.payments };
  }

  startPayment(principal: AnyPrincipal, requestId: string, approvalId: string): PaymentOutcome {
    if (!canPayRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const a = this.owned(principal, requestId, approvalId);
    if (!a) return { status: "NOT_FOUND" };
    const out = this.d.store.transaction((): PaymentOutcome => {
      if (!canPayRequest(principal, requestId)) return { status: "NOT_FOUND" };
      // Inside the lock: validity() re-reads the approver's current assignment by grant sequence (assignmentProblems)
      // unless a terminal event already ended the approval — it never relies on a page view or an event written first.
      const v = this.validity(principal, a, true);
      if (v.state !== "ACTIVE") {
        this.auditInTx(principal, "PAYMENT_START", requestId, "DENIED", { approval: a.id, reason: v.reasons.join(",") });
        return { status: "APPROVAL_INVALID", validity: v };
      }
      const legacy = this.notPayable(a);
      if (legacy) {
        this.auditInTx(principal, "PAYMENT_START", requestId, "DENIED", { approval: a.id, reason: legacy });
        return { status: "NOT_PAYABLE", reason: legacy };
      }
      const own = this.d.store.payments(a.id).filter((p) => !FAIL_FREE_STATUSES.has(p.status));
      if (own.length > 0) return { status: "EXISTING", payment: own[own.length - 1] };
      for (const p of this.d.store.paymentsForRequest(requestId)) {
        if (p.status === "PAID") return { status: "ALREADY_PAID", recordId: p.recordId };
        if (!["FAILED", "NEW", "ORDER_CREATED"].includes(p.status)) return { status: "PAYMENT_OUTCOME_OPEN", recordId: p.recordId };
      }
      const recordId = `tp_${randomUUID()}`;
      const label = this.d.paymentLabel?.() ?? { sku: "TP-APPROVAL", suffix: "(Sandbox)" };
      this.d.store.insertPayment(a, recordId, randomUUID(), `TradeProof approval ${shortProcurementId(requestId)} ${shortSeriesId(a.seriesId)} v${a.snapshot.quote.versionNumber} ${label.suffix}`, label.sku);
      this.auditInTx(principal, "PAYMENT_START", requestId, "OK", { approval: a.id, record: recordId });
      return { status: "CREATED", payment: this.d.store.payments(a.id).find((p) => p.recordId === recordId)! };
    });
    return out;
  }

  private current(a: StoredApproval): LinkedPayment | null {
    const list = this.d.store.payments(a.id).filter((p) => !FAIL_FREE_STATUSES.has(p.status));
    return list[list.length - 1] ?? null;
  }

  /** The approval's current (not FAILED) payment record, if any. Read-only. */
  currentPayment(principal: AnyPrincipal, requestId: string, approvalId: string): LinkedPayment | null {
    if (!canPayRequest(principal, requestId)) return null;
    const a = this.owned(principal, requestId, approvalId);
    return a ? this.current(a) : null;
  }

  private async paymentStep(principal: AnyPrincipal, requestId: string, approvalId: string, step: (svc: PaymentService, recordId: string, guard: () => string | null) => Promise<ServiceResult>): Promise<PaymentOutcome> {
    if (!canPayRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const a = this.owned(principal, requestId, approvalId);
    if (!a) return { status: "NOT_FOUND" };
    const rec = this.current(a);
    if (!rec) return { status: "NO_PAYMENT" };
    // Read-only guard, evaluated inside the payment's write transaction (no writes through this connection there).
    const guard = () => {
      if (!canPayRequest(principal, requestId)) return "NOT_OWNER";
      const legacy = this.notPayable(a);
      if (legacy) return legacy;
      // Current assignment by grant sequence, independent of events and of any page (R-ACCESS-CLOCK).
      const assignment = this.assignmentProblems(a);
      if (assignment.length > 0) return assignment.join(",");
      const events = this.d.store.events(a.id);
      if (events.length > 0) return events.map((e) => e.kind).join(",");
      const problems = this.validityProblems(principal, a);
      return problems.length > 0 ? problems.join(",") : null;
    };
    const result = await step(this.d.payments(), rec.recordId, guard);
    if (result.code === "APPROVAL_INVALID") {
      this.recordInvalidation(principal, a);
      this.auditBestEffort(principal, "PAYMENT_STEP", requestId, "DENIED", { approval: a.id, record: rec.recordId, reason: "APPROVAL_INVALID" });
    }
    return { status: "PAYPAL", result };
  }

  createOrder(principal: AnyPrincipal, requestId: string, approvalId: string): Promise<PaymentOutcome> {
    return this.paymentStep(principal, requestId, approvalId, (svc, id, guard) => svc.createPayPalOrder(id, { guard }));
  }

  capture(principal: AnyPrincipal, requestId: string, approvalId: string, clientOrderId?: string): Promise<PaymentOutcome> {
    return this.paymentStep(principal, requestId, approvalId, (svc, id, guard) => svc.capture(id, clientOrderId, { guard, noResendAfterUnknown: true }));
  }

  reconcile(principal: AnyPrincipal, requestId: string, approvalId: string): Promise<PaymentOutcome> {
    return this.paymentStep(principal, requestId, approvalId, (svc, id, guard) => svc.reconcile(id, { guard, noResendAfterUnknown: true }));
  }
}
