// Copilot fact builder (2 Nov; plan §2–§3.3). Deterministic and READ-ONLY on business data: it reads one procurement
// record through the existing read-only services (ComparisonService.compare, ApprovalService.readFacts — computed
// validity, never `view` / `list` — ClarificationService.list, ReplyService.view) after `canReadRequest`, and builds:
//   - the facts layer (F1…Fn, plain English, each with the stored ids it comes from);
//   - the links the panel may show (L1…Ln, built here from a fixed route list — never from model text);
//   - the deterministic next step (fixed precedence, role-aware);
//   - the basis (hashed parts) used to tell whether an answer is still current.
// Nothing here calls a model, writes a row or reads another record. Supplier text (quotes, replies) is included
// verbatim and marked untrusted: it is data, never an instruction, and its numbers can never back a sentence.

import { createHash } from "node:crypto";
import { approvalEntry, approvalHref, type ApprovalEntry, type EntryChoices } from "../../lib/approval-entry.ts";
import type { Comparison, ComparisonRow, QuoteValue } from "../../lib/comparison.ts";
import { shortDraftRef } from "../../lib/clarification.ts";
import { BASIS_PARTS, RULE_ANSWERED_NOT_APPROVED, type BasisPart, type CopilotBasis, type CopilotFact, type CopilotIntent, type CopilotLink, type FactTag } from "../../lib/copilot.ts";
import { shortItemRef, shortProcurementId, type ProcurementRecord } from "../../lib/procurement.ts";
import { shortSeriesId, type QuoteSeries } from "../../lib/quote-versions.ts";
import { en } from "../../i18n/en.ts";
import { canApproveRequest, canAssignApprover, canReadRequest, type Principal } from "../access/policy.ts";
import type { ApprovalFacts, ApprovalService } from "../approval/service.ts";
import type { Evaluation, FeeEntry } from "../approval/evaluate.ts";
import type { DraftSummary } from "../clarification/store.ts";
import type { ClarificationService } from "../clarification/service.ts";
import type { CompareOutcome, ComparisonService } from "../comparison/service.ts";
import { minorDigits } from "../payments/money.ts";
import type { ProcurementStore } from "../procurement/store.ts";
import type { QuoteStore } from "../quotes/store.ts";
import type { ReplyService, ReplyView } from "../replies/service.ts";

/** Read-only sources. Every one of them checks access again itself. */
export interface CopilotSources {
  procurement: Pick<ProcurementStore, "get">;
  quotes: Pick<QuoteStore, "listSeries" | "getVersion">;
  comparison: Pick<ComparisonService, "compare">;
  approvals: Pick<ApprovalService, "readFacts">;
  clarification: Pick<ClarificationService, "list">;
  replies: Pick<ReplyService, "view">;
  /** Owner only: whether an approver is assigned now (AuthService.approverState). */
  approverAssigned: (requestId: string) => boolean;
  /** Whether approval payments are switched on in this server (payment-mode.ts). */
  paymentsEnabled: () => boolean;
  /** This server's payment mode (payment-mode.ts); MOCK only on a database copy. Default: treated as not MOCK. */
  paymentMode?: () => "OFF" | "SANDBOX" | "MOCK" | "REFUSED";
}

/** What the browser names; everything else is read on the server. */
export interface Selection {
  seriesId: string | null;
  versionId: string | null;
  runId: string | null;
  baseRunId: string | null;
}

export interface Resolved {
  seriesId: string | null;
  versionId: string | null;
  runId: string | null;
  baseRunId: string | null;
}

export interface Built {
  facts: CopilotFact[];
  links: CopilotLink[];
  nextStep: { text: string; link: string | null } | null;
  /** Fixed rules the panel shows with the answer (server text). */
  notices: string[];
  basis: CopilotBasis;
  resolved: Resolved;
}

/** Version of the fact selection / wording (recorded with acceptance evidence). */
export const COPILOT_FACTS_VERSION = "copilot-facts-2026-11-03.7";
// .7 (3 Nov, owner decision): payment wording by the actual environment (a stored record by its SKU; proposed amounts
// by this server's payment mode) — MOCK is never called a Sandbox payment; the assigned approver's next step at a
// non-blocked rule check is the approval it may make; question fields shown by readable name (question id kept);
// a BLOCK finding repeated with the same code, subject and wording is listed once, and the same code from a different
// subject names its basis. For a record without a MOCK payment and outside MOCK mode, the payment texts are unchanged.

/** Readable names for clarification question fields (the stable question id stays in the fact's data). */
const FIELD_NAME: Record<string, string> = { paymentTerms: "payment terms", leadTime: "lead time", incoterm: "trade term", unitPrice: "unit price", total: "total" };
const fieldName = (field: string) => FIELD_NAME[field] ?? field;
/** Basis named when one finding code comes from more than one subject (e.g. BUDGET_NOT_COMPARABLE). */
const SUBJECT_NAME: Record<string, string> = { currency: "quote currency vs budget currency", budget: "quote total vs budget cap", total: "quote total", paymentTerms: "payment terms" };
const MOCK_SKU = "TP-APPROVAL-MOCK";

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface Snapshot {
  principal: Principal;
  role: "OWNER" | "APPROVER";
  record: ProcurementRecord;
  series: QuoteSeries[];
  current: QuoteSeries | null;
  versionId: string | null;
  versionNumber: number | null;
  latestVersionNumber: number | null;
  rawText: string | null;
  choices: EntryChoices | null;
  entry: ApprovalEntry | null;
  comparison: Comparison | null;
  compareRefusal: string | null;
  approval: ApprovalFacts;
  drafts: DraftSummary[];
  latestDraft: ReplyView | null;
  approverAssigned: boolean | null;
  paymentsEnabled: boolean;
  mockPayments: boolean;
}

// ---------- gather (read-only) ----------

function gather(src: CopilotSources, principal: Principal, requestId: string, sel: Selection): Snapshot | null {
  if (!canReadRequest(principal, requestId)) return null;
  const record = src.procurement.get(requestId);
  if (!record) return null;
  const series = src.quotes.listSeries(requestId);
  const role = canApproveRequest(principal, requestId) ? "APPROVER" : "OWNER";
  const base = {
    principal,
    role,
    record,
    series,
    approverAssigned: canAssignApprover(principal, requestId) ? src.approverAssigned(requestId) : null,
    paymentsEnabled: src.paymentsEnabled(),
    mockPayments: src.paymentMode?.() === "MOCK",
  } as const;

  if (sel.seriesId === null || sel.versionId === null) {
    // Only a record without any saved quote may be asked about without naming a version (the panel sits on a version).
    if (series.some((s) => s.versions.length > 0)) return null;
    const approval = src.approvals.readFacts(principal, requestId, null);
    if (!approval) return null;
    return { ...base, current: null, versionId: null, versionNumber: null, latestVersionNumber: null, rawText: null, choices: null, entry: null, comparison: null, compareRefusal: null, approval, drafts: [], latestDraft: null };
  }

  const current = series.find((s) => s.id === sel.seriesId) ?? null;
  const version = src.quotes.getVersion(requestId, sel.seriesId, sel.versionId);
  if (!current || !version) return null;
  const chooseOut = src.comparison.compare(principal, requestId, sel.seriesId, sel.versionId, null, null);
  if (chooseOut.status !== "CHOOSE") return null;
  const c = chooseOut.choices;
  const choices: EntryChoices = {
    version: { id: c.version.id, versionNumber: c.version.versionNumber, latestVersionNumber: c.version.latestVersionNumber, contentKind: c.version.contentKind },
    runs: c.runs.map((r) => ({ id: r.id, mode: r.mode, model: r.model, startedAt: r.startedAt, refusal: r.refusal })),
    base: c.base ? { versionId: c.base.versionId, versionNumber: c.base.versionNumber, runs: c.base.runs.map((r) => ({ id: r.id, mode: r.mode, model: r.model, startedAt: r.startedAt, refusal: r.refusal })) } : null,
  };
  // Same rule as the Quotes-page approval entry: a named run only if usable for THIS version, else the newest usable one.
  const entry = approvalEntry({ requestId, seriesId: sel.seriesId, versionId: sel.versionId }, choices, role, base.approverAssigned, sel.runId);
  let comparison: Comparison | null = null;
  let compareRefusal: string | null = null;
  let approval: ApprovalFacts | null;
  if (entry.kind === "PREVIEW") {
    const out: CompareOutcome = src.comparison.compare(principal, requestId, sel.seriesId, sel.versionId, entry.run.id, entry.baseRun?.id ?? null);
    if (out.status === "NOT_FOUND" || out.status === "CHOOSE") return null;
    if (out.status === "REFUSED") compareRefusal = out.code;
    else comparison = out.comparison;
    approval = src.approvals.readFacts(principal, requestId, { seriesId: sel.seriesId, versionId: sel.versionId, runId: entry.run.id, baseRunId: entry.baseRun?.id ?? null });
  } else approval = src.approvals.readFacts(principal, requestId, null);
  if (!approval) return null;
  const drafts = src.clarification.list(principal, requestId, sel.seriesId, sel.versionId) ?? [];
  const latestDraft = drafts.length > 0 ? src.replies.view(principal, requestId, drafts[0].id) : null;
  return {
    ...base,
    current,
    versionId: sel.versionId,
    versionNumber: c.version.versionNumber,
    latestVersionNumber: c.version.latestVersionNumber,
    rawText: version.rawText,
    choices,
    entry,
    comparison,
    compareRefusal,
    approval,
    drafts,
    latestDraft,
  };
}

// ---------- basis ----------

function basisOf(s: Snapshot): CopilotBasis {
  const e = s.approval.evaluation;
  const raw: Record<BasisPart, unknown> = {
    request: [s.record.id, s.record.revision],
    quote: [s.versionId, s.latestVersionNumber, s.series.map((x) => [x.id, x.versions.length])],
    run: [s.entry?.kind === "PREVIEW" ? [s.entry.run.id, s.entry.baseRun?.id ?? null] : null, s.choices?.runs.map((r) => [r.id, r.refusal]) ?? []],
    reviews: e ? e.snapshot.digests.reviews : null,
    statements: e ? e.snapshot.digests.statements : null,
    classifications: e ? e.snapshot.digests.classifications : null,
    approvals: s.approval.approvals.map((a) => [a.approval.id, a.validity.state, a.validity.reasons]),
    drafts: s.drafts.map((d) => [d.id, d.revision]),
    replies: s.latestDraft ? [s.latestDraft.seriesReplies.map((r) => r.id), s.latestDraft.links.map((l) => l.id), s.latestDraft.questions.map((q) => [q.questionId, q.latest?.id ?? null, q.basisCurrent])] : null,
    payments: s.approval.approvals.map((a) => a.payments.map((p) => [p.recordId, p.status])),
  };
  const parts = Object.fromEntries(BASIS_PARTS.map((p) => [p, hash(JSON.stringify(raw[p])).slice(0, 16)])) as Record<BasisPart, string>;
  return { digest: hash(`copilot-basis-1\n${BASIS_PARTS.map((p) => parts[p]).join("\n")}`), parts };
}

// ---------- text helpers ----------

const FINDINGS = en.approval.findings as unknown as Record<string, ((a: Record<string, string>) => string) | undefined>;
const findingText = (code: string, args: Record<string, string>) => FINDINGS[code]?.(args) ?? Object.entries(args).map(([k, v]) => `${k}: ${v}`).join("; ");

function origin(v: QuoteValue): string {
  if (v.used === null) return "not stated in the quote";
  switch (v.usedFrom) {
    case "USER_CONFIRMED":
      return "confirmed by the buyer";
    case "USER_CORRECTED":
      return "corrected by the buyer";
    default:
      return "extracted, not yet reviewed";
  }
}

function money(minor: number, currency: string): string {
  const d = minorDigits(currency) ?? 2;
  return `${currency} ${(minor / 10 ** d).toFixed(d)}`;
}

const VALIDITY: Record<string, string> = { ACTIVE: "Active", INVALIDATED: "No longer valid", REVOKED: "Revoked" };
const Q_STATE: Record<string, string> = {
  OPEN: "Open — no answer recorded",
  NOT_ANSWERED: "Not answered by the supplier",
  PARTLY_ANSWERED: "Partly answered",
  ANSWERED: "Answered",
  STATEMENT_RECORDED: "Answered — the buyer recorded a statement",
};
const UNRESOLVED_STATES = new Set(["OPEN", "NOT_ANSWERED", "PARTLY_ANSWERED"]);
const PENDING_REVIEW = /_NOT_REVIEWED$|_NOT_STATED$|^PAIRING_NOT_CONFIRMED$/;
// Two separate dimensions (owner, 2 Nov re-validation): the fee CATEGORY (TradeProof's classification) and the PAYMENT
// SCOPE (whether it is inside the amount of this payment). "Excluded" is only ever a category name here.
const FEE_BUCKETS: [keyof Evaluation["snapshot"]["money"], string][] = [
  ["included", "Fee category: Included (inside the stated total) · payment scope: inside the stated total, so part of the payment amount"],
  ["excluded", "Fee category: Excluded (a firm lump sum paid to someone else) · payment scope: not included in the payment amount"],
  ["unknown", "Fee category: Unknown cost · payment scope: not included in the payment amount"],
  ["unverified", "Fee category: Unverified estimate · payment scope: not included in the payment amount"],
  ["duplicates", "Fee category: Possible duplicate of goods already priced (to be checked) · payment scope: not added to the payment amount"],
  ["notApplicable", "Fee category: Not applicable · payment scope: not included in the payment amount"],
];

// ---------- builder ----------

class Bundle {
  facts: CopilotFact[] = [];
  links: CopilotLink[] = [];
  add(text: string, tags: FactTag[], source: CopilotFact["source"], trusted = true, extra: { key: string; mention?: string }): string {
    const id = `F${this.facts.length + 1}`;
    this.facts.push({ id, text, trusted, tags, source, key: extra.key, ...(extra.mention ? { mention: extra.mention } : {}) });
    return id;
  }
  link(label: string, href: string): string {
    const existing = this.links.find((l) => l.href === href);
    if (existing) return existing.id;
    const id = `L${this.links.length + 1}`;
    this.links.push({ id, label, href });
    return id;
  }
}

function routes(s: Snapshot) {
  const id = s.record.id;
  const q = s.current && s.versionId ? `?series=${s.current.id}&version=${s.versionId}` : "";
  const run = s.entry?.kind === "PREVIEW" ? s.entry.run.id : null;
  const baseRun = s.entry?.kind === "PREVIEW" ? (s.entry.baseRun?.id ?? null) : null;
  return {
    quotes: () => [`Quotes page${s.versionNumber ? ` (version ${s.versionNumber})` : ""}`, `/procurements/${id}/quotes${q}`] as const,
    compare: () => (run && s.current && s.versionId ? ([`Compare page (version ${s.versionNumber})`, `/procurements/${id}/quotes/compare${q}&run=${run}${baseRun ? `&baseRun=${baseRun}` : ""}`] as const) : null),
    approval: () =>
      s.current && s.versionId
        ? ([s.role === "APPROVER" ? "Approval page — review and approve this version" : "Approval page — preview and status", approvalHref(id, s.current.id, s.versionId, run, baseRun)] as const)
        : null,
    draft: (draftId: string) => [`Clarification draft ${shortDraftRef(draftId)} (questions and supplier replies)`, `/procurements/${id}/quotes/drafts/${draftId}`] as const,
    access: () => (s.role === "OWNER" ? (["Request page → Access (assign an approver)", `/procurements/${id}`] as const) : null),
  };
}

function header(b: Bundle, s: Snapshot): void {
  b.add(`Request ${shortProcurementId(s.record.id)}, revision ${s.record.revision}: “${s.record.title}”.`, ["REQUEST"], { requestId: s.record.id, revision: s.record.revision }, true, { key: "REQUEST" });
  b.add(
    s.role === "OWNER"
      ? "You are the buyer who owns this request. Buyers never approve; only the approver you assign can approve. You can pay an Active approval only when payments are switched on."
      : "You are the approver assigned to this request. You may approve on the approval page when nothing blocks it; you cannot edit the request, quotes or replies, and you cannot pay.",
    ["ROLE", "APPROVAL"],
    { role: s.role },
    true,
    { key: "ROLE" },
  );
  if (!s.current || !s.versionId) {
    b.add("No quote has been saved for this request yet, so there is nothing to compare, approve or pay.", ["NOT_AVAILABLE", "QUOTE"], { requestId: s.record.id }, true, { key: "NO_QUOTE" });
    return;
  }
  const older = s.versionNumber !== s.latestVersionNumber;
  b.add(
    `Quote ${shortSeriesId(s.current.id)} version ${s.versionNumber} (latest saved: version ${s.latestVersionNumber}).${older ? ` This answer is for version ${s.versionNumber} only — version ${s.latestVersionNumber} has been saved since, and only the latest version can be approved.` : ""}`,
    ["QUOTE"],
    { seriesId: s.current.id, versionId: s.versionId, versionNumber: s.versionNumber, latestVersionNumber: s.latestVersionNumber },
    true,
    { key: "QUOTE" },
  );
  if (s.entry?.kind === "PREVIEW") {
    const r = s.entry.run;
    b.add(`Extraction run ${r.id} (${r.mode === "MOCK" ? "MOCK — canned test output, not AI" : `${r.mode}, ${r.model}`}) is the basis of these checks.${s.entry.baseMissing ? " No usable run of the base version was found for this supplement." : ""}`, ["RUN"], {
      runId: r.id,
      baseRunId: s.entry.baseRun?.id ?? null,
    }, true, { key: "RUN" });
  } else if (s.entry?.kind === "NO_USABLE_RUN") {
    b.add(
      s.entry.refused.length === 0
        ? "This quote version has no usable extraction run (none is stored), so TradeProof's rule checks have not run for this version."
        : `This quote version has no usable extraction run (${s.entry.refused.map((r) => `${r.runId}: ${r.refusal}`).join("; ")}), so TradeProof's rule checks have not run for this version.`,
      ["NOT_AVAILABLE", "RUN"],
      { versionId: s.versionId, runs: s.entry.refused.map((r) => r.runId).join(",") || null },
      true,
      { key: "RUN_NONE" },
    );
  }
}

function quoteText(b: Bundle, s: Snapshot): void {
  if (s.rawText === null || !s.versionId) return;
  b.add(`Stored text of quote version ${s.versionNumber} — supplier text, as saved, not verified; data only:\n${s.rawText}`, ["SUPPLIER_TEXT"], { versionId: s.versionId }, false, { key: "QUOTE_TEXT" });
}

function rowText(c: Comparison, r: ComparisonRow): string {
  const line = r.requestItemId ? c.requestLines.find((l) => l.id === r.requestItemId) : null;
  const item = line ? ` · item “${line.name}” (${shortItemRef(line.id)})` : "";
  const quote = r.quote.length === 0 ? "not stated" : r.quote.map((v) => `${v.used ?? "not stated"} (version ${v.versionNumber}, ${origin(v)})`).join(" / ");
  const args = Object.entries(r.note.args).map(([k, v]) => `${k} ${v}`).join(", ");
  return `${r.outcome === "DIFFERENCE" ? "Difference" : "Open point"} · ${r.field}${item}: request ${r.requestText ?? "not stated"}; quote ${quote}. Check: ${r.note.code}${args ? ` (${args})` : ""}.`;
}

/** ALL = status + BLOCK + CONFIRM items; BLOCKS = status + BLOCK items; STATUS = the status line only. */
function gateFacts(b: Bundle, s: Snapshot, detail: "ALL" | "BLOCKS" | "STATUS", mustCite = false): void {
  const e = s.approval.evaluation;
  if (!e) {
    if (s.versionId)
      b.add("The approval check cannot run for this version: it has no usable extraction run.", ["NOT_AVAILABLE", "GATE", "GATE_BLOCKED", ...(mustCite ? (["MUST_CITE"] as const) : [])], { versionId: s.versionId }, true, {
        key: "GATE_NONE",
        ...(mustCite ? { mention: "cannot run|no usable|not run" } : {}),
      });
    return;
  }
  const blocks = e.findings.filter((f) => f.level === "BLOCK");
  const confirms = e.findings.filter((f) => f.level === "CONFIRM");
  // Narrowed (owner, 2 Nov night): the result of TradeProof's current rules — not a judgement of the whole quote.
  const status =
    e.status === "BLOCKED"
      ? "BLOCKED by the current rules"
      : e.status === "READY"
        ? "READY — the current rules found no blocking item"
        : "READY WITH CONFIRMATIONS — the current rules found no blocking item; each listed item still has to be confirmed by the approver when approving";
  const mention = e.status === "BLOCKED" ? "block" : e.status === "READY" ? "no blocking|ready" : "confirm";
  b.add(
    `Current rule check of quote version ${e.snapshot.quote.versionNumber} with run ${e.snapshot.runs.run.id}: ${status} (${blocks.length} blocking, ${confirms.length} to confirm). This is TradeProof's rule check — not an approval and not a judgement of the whole quote.`,
    ["GATE", e.status === "BLOCKED" ? "GATE_BLOCKED" : "GATE_READY", ...(mustCite ? (["MUST_CITE"] as const) : [])],
    { versionId: e.snapshot.quote.versionId, runId: e.snapshot.runs.run.id, requestRevision: e.snapshot.request.revision, digest: e.digest.slice(0, 16) },
    true,
    { key: "GATE", ...(mustCite ? { mention } : {}) },
  );
  if (detail === "STATUS") return;
  const seen = new Set<string>();
  for (const f of blocks) {
    const text = findingText(f.code, f.args);
    const same = `${f.code}|${f.subject}|${text}`;
    if (seen.has(same)) continue; // the same reason from the same source: listed once
    seen.add(same);
    const otherBasis = blocks.some((g) => g !== f && g.code === f.code && g.subject !== f.subject);
    const basis = otherBasis ? `, ${SUBJECT_NAME[f.subject] ?? f.subject}` : "";
    b.add(`Blocking (${f.code}${basis}): ${text}`, ["BLOCK", "GATE", "GATE_BLOCKED"], { finding: f.key, subject: f.subject }, true, { key: `BLOCK:${f.key}` });
  }
  if (detail === "ALL") for (const f of confirms) b.add(`To confirm (${f.code}): ${findingText(f.code, f.args)}`, ["CONFIRM", "GATE"], { finding: f.key, subject: f.subject }, true, { key: `CONFIRM:${f.key}` });
}

/** `mustCite` (payment answers): whether a valid (Active) approval exists must be cited and stated. */
function approvalFacts(b: Bundle, s: Snapshot, mustCite = false): void {
  if (s.role === "OWNER") {
    b.add(s.approverAssigned ? "An approver is assigned to this request." : "No approver is assigned to this request yet (request page → Access).", ["ROLE", "APPROVAL"], { requestId: s.record.id }, true, { key: "APPROVER_ASSIGNMENT" });
  }
  const must = mustCite ? (["MUST_CITE"] as const) : [];
  const mention = mustCite ? { mention: "approv" } : {};
  if (s.approval.approvals.length === 0) {
    b.add("No approval has been recorded for this request.", ["APPROVAL", "NOT_AVAILABLE", ...must], { requestId: s.record.id }, true, { key: "APPROVAL_NONE", ...mention });
    return;
  }
  if (mustCite) {
    const active = s.approval.approvals.filter((a) => a.validity.state === "ACTIVE");
    b.add(
      active.length > 0
        ? `Valid (Active) approval: ${active.map((a) => a.approval.id).join(", ")}. Whether a payment can start also depends on the buyer role, the payment switch of this server and any payment already made or in progress.`
        : `There is no valid (Active) approval: ${s.approval.approvals.length} approval(s) recorded, none Active.`,
      ["APPROVAL", ...(active.length > 0 ? (["APPROVAL_ACTIVE", "PAYMENT"] as const) : (["NOT_AVAILABLE"] as const)), ...must],
      { requestId: s.record.id, active: active.length },
      true,
      { key: "APPROVAL_SUMMARY", ...mention },
    );
  }
  for (const a of s.approval.approvals) {
    const amount = a.approval.snapshot.money.thisPayment?.display ?? money(a.approval.amountMinor, a.approval.currency);
    const state = VALIDITY[a.validity.state] ?? a.validity.state;
    b.add(
      `Approval ${a.approval.id} of quote version ${a.approval.snapshot.quote.versionNumber} for ${amount}, by ${a.actorLabel}, ${a.approval.createdAt}: ${state}${a.validity.reasons.length ? ` (${a.validity.reasons.join(", ")})` : ""}.`,
      ["APPROVAL", ...(a.validity.state === "ACTIVE" ? (["APPROVAL_ACTIVE"] as const) : [])],
      { approvalId: a.approval.id, versionId: a.approval.versionId, runId: a.approval.runId, grantSeq: a.approval.approverGrantSeq ?? null, state: a.validity.state },
      true,
      { key: `APPROVAL:${a.approval.id}` },
    );
  }
}

function paymentFacts(b: Bundle, s: Snapshot): void {
  const all = s.approval.approvals.flatMap((a) => a.payments.map((p) => ({ a, p })));
  if (all.length === 0) {
    b.add(s.mockPayments ? "No payment has been started for this request (this server uses MOCK payments: simulated PayPal on a database copy, no PayPal request)." : "No Sandbox payment has been started for this request.", ["PAYMENT"], { requestId: s.record.id }, true, { key: "PAYMENT_NONE" });
    return;
  }
  for (const { a, p } of all) {
    const mock = p.sku === MOCK_SKU;
    b.add(mock ? `MOCK payment ${p.recordId} of approval ${a.approval.id}: ${p.status} (${money(p.amountMinor, p.currency)}). Simulated PayPal on a database copy — no PayPal request, no money moved; not a Sandbox payment.` : `Sandbox payment ${p.recordId} of approval ${a.approval.id}: ${p.status} (${money(p.amountMinor, p.currency)}). PayPal Sandbox only — no real money.`, ["PAYMENT", ...(p.status === "PAID" ? (["PAID"] as const) : [])], {
      paymentRecordId: p.recordId,
      approvalId: a.approval.id,
      status: p.status,
    }, true, { key: `PAYMENT:${p.recordId}` });
  }
}

function feeText(label: string, f: FeeEntry): string {
  return `${label}: ${f.description ?? f.kind ?? `fee #${f.index + 1}`} — ${f.amount ?? "amount not stated"}${f.amount && !f.amountReviewed ? " (amount not reviewed)" : ""}; payer ${f.payer ?? "unknown"}, paid to ${f.payee ?? "unknown"}${f.statedAs ? `, stated as ${f.statedAs}` : ""}${f.basis ? `, basis ${f.basis}` : ""} (quote version ${f.versionNumber}).`;
}

function moneyFacts(b: Bundle, s: Snapshot): void {
  const e = s.approval.evaluation;
  if (!e) {
    b.add("No payable amount: without a usable extraction run TradeProof has no checked amount for this version.", ["NOT_AVAILABLE", "AMOUNT"], { versionId: s.versionId }, true, { key: "AMOUNT_NONE" });
    return;
  }
  const m = e.snapshot.money;
  const active = s.approval.approvals.some((a) => a.validity.state === "ACTIVE");
  if (m.thisPayment) {
    // Owner, 2 Nov night: without a valid approval this is a proposed amount, never something that can be paid now.
    b.add(
      active
        ? `Amount for a ${s.mockPayments ? "MOCK payment (simulated PayPal)" : "Sandbox payment"}: ${m.thisPayment.display} (${m.thisPayment.minor} minor units of ${m.thisPayment.currency}) — the quote's full stated total, paid once (FULL_STATED_TOTAL); an Active approval exists. Whether a payment can start also depends on the buyer role, the payment switch of this server and any payment already made or in progress.`
        : `Proposed amount for a ${s.mockPayments ? "MOCK payment (simulated PayPal)" : "Sandbox payment"} (the quote amount): ${m.thisPayment.display} (${m.thisPayment.minor} minor units of ${m.thisPayment.currency}) — the quote's full stated total, to be paid once (FULL_STATED_TOTAL). There is no valid approval, so this is not payable now and not a payment authorisation.`,
      ["AMOUNT", "PAYMENT"],
      { versionId: e.snapshot.quote.versionId, runId: e.snapshot.runs.run.id, digest: e.digest.slice(0, 16) },
      true,
      { key: "AMOUNT_THIS" },
    );
  } else {
    const codes = e.findings.filter((f) => f.level === "BLOCK").map((f) => f.code);
    b.add(`No payable amount: the approval check is BLOCKED (${codes.join(", ")}), so TradeProof gives no amount for this payment.`, ["NOT_AVAILABLE", "AMOUNT", "GATE", "GATE_BLOCKED"], { versionId: e.snapshot.quote.versionId, runId: e.snapshot.runs.run.id }, true, { key: "AMOUNT_NONE" });
  }
  if (m.statedTotal) b.add(`Stated total in the quote (reviewed): ${m.statedTotal}.`, ["AMOUNT"], { versionId: e.snapshot.quote.versionId, runId: e.snapshot.runs.run.id }, true, { key: "STATED_TOTAL" });
  if (m.goodsSubtotal) b.add(`Sum of the quoted item lines: ${m.goodsSubtotal}.`, ["AMOUNT"], { versionId: e.snapshot.quote.versionId, runId: e.snapshot.runs.run.id }, true, { key: "LINES_SUM" });
  for (const [bucket, label] of FEE_BUCKETS) {
    for (const f of m[bucket] as FeeEntry[]) b.add(feeText(label, f), ["FEE", "AMOUNT"], { versionId: e.snapshot.quote.versionId, runId: e.snapshot.runs.run.id, fee: `${f.source}:${f.index}` }, true, { key: `FEE:${f.source}:${f.index}` });
  }
  b.add("Landed cost (duties, taxes, delivery to the destination) is not calculated in this version of TradeProof.", ["NOT_AVAILABLE", "AMOUNT"], { landedCost: m.landedCost }, true, { key: "LANDED" });
}

function draftFacts(b: Bundle, s: Snapshot, withTexts: boolean): void {
  const v = s.latestDraft;
  if (!v || s.drafts.length === 0) {
    b.add("No clarification draft exists for this quote version, so no question has been sent or answered.", ["NOT_AVAILABLE", "DRAFT"], { versionId: s.versionId }, true, { key: "DRAFT_NONE" });
    return;
  }
  const d = s.drafts[0];
  b.add(
    `Clarification draft ${shortDraftRef(d.id)} (revision ${v.latestRevision}, ${v.questions.length} questions) for quote version ${v.askedVersionNumber}. Supplier replies linked to it: ${v.links.length}; replies saved for this quote series: ${v.seriesReplies.length}.`,
    ["DRAFT", "REPLY"],
    { draftId: d.id, draftRevision: v.latestRevision, links: v.links.length, replies: v.seriesReplies.length },
    true,
    { key: "DRAFT" },
  );
  const sorted = [...v.questions].sort((x, y) => Number(!UNRESOLVED_STATES.has(x.state)) - Number(!UNRESOLVED_STATES.has(y.state)) || x.number - y.number);
  for (const q of sorted) {
    const extra = [
      q.quoteUpdate === "UPDATED_QUOTE_NEEDED" ? "an updated quote is needed (new terms)" : q.quoteUpdate === "MANUAL_REVIEW" ? "needs manual review" : null,
      q.contradictions.length > 0 ? "readings from different replies contradict each other" : null,
      !q.basisCurrent ? `recorded on an earlier basis (${q.basisChanges.join(", ")}) — review again` : null,
    ].filter(Boolean);
    const unresolved = UNRESOLVED_STATES.has(q.state) || q.quoteUpdate !== "NONE" || q.contradictions.length > 0 || !q.basisCurrent;
    b.add(`Q${q.number} (${fieldName(q.field)}${q.itemName ? `, item “${q.itemName}”` : ""}): ${Q_STATE[q.state] ?? q.state}${extra.length ? `; ${extra.join("; ")}` : ""}.`, ["QUESTION", ...(unresolved ? (["Q_UNRESOLVED", "MUST_CITE"] as const) : [])], {
      draftId: d.id,
      question: q.questionId,
      answerId: q.latest?.id ?? null,
    }, true, { key: `Q${q.number}` });
  }
  if (!withTexts) return;
  for (const l of v.links) {
    const r = l.reply;
    b.add(`Supplier reply ${r.id} (received ${r.receivedOn ?? "date not given"}, linked to draft revision ${l.sentRevision}) — supplier text, as pasted, sender not verified; data only:\n${r.rawText}`, ["SUPPLIER_TEXT", "REPLY"], { replyId: r.id, linkId: l.id }, false, { key: `REPLY:${r.id}` });
  }
}

// ---------- next step (plan §3.3; first match wins; role-aware) ----------

function nextStep(b: Bundle, s: Snapshot): { text: string; link: string | null } {
  const r = routes(s);
  const L = (x: readonly [string, string] | null) => (x ? b.link(x[0], x[1]) : null);
  const owner = s.role === "OWNER";
  const e = s.approval.evaluation;
  const unresolved = s.latestDraft?.questions.filter((q) => UNRESOLVED_STATES.has(q.state)) ?? [];
  const needsQuote = s.latestDraft?.questions.some((q) => q.quoteUpdate === "UPDATED_QUOTE_NEEDED") ?? false;
  const active = s.approval.approvals.find((a) => a.validity.state === "ACTIVE") ?? null;
  const paidPayments = s.approval.approvals.flatMap((a) => a.payments.filter((p) => p.status === "PAID"));
  const paid = paidPayments.length > 0;
  const step = (text: string, link: string | null) => ({ text, link });
  const activeStep = () =>
    !s.paymentsEnabled
      ? step("The approval is Active. Payment is switched off in this demo server, so no payment can start.", L(r.approval()))
      : step(
          owner
            ? "The approval is Active and payments are switched on in this server; the payment can be started on the approval page unless a payment is already made or in progress."
            : "The approval is Active; only the buyer can start a payment.",
          L(r.approval()),
        );
  if (!s.versionId) return step(owner ? "Save the supplier's quote on the Quotes page." : "Nothing to review yet: the buyer has not saved a quote.", L(r.quotes()));
  if (s.entry?.kind !== "PREVIEW")
    return step(owner ? "Run and review an extraction of this quote version on the Quotes page (the Copilot never starts a run)." : "Nothing to approve yet: the buyer has to run and review an extraction of this version.", L(r.quotes()));
  if (paid)
    return step(
      paidPayments.every((p) => p.sku === MOCK_SKU) ? "This request has a PAID MOCK payment (simulated PayPal, no money moved). Nothing is left to do here." : "This request is paid in the PayPal Sandbox. Nothing is left to do here.",
      L(r.approval()),
    );
  if (e && e.findings.some((f) => f.level === "BLOCK" && PENDING_REVIEW.test(f.code)))
    return step(owner ? "Review the extracted values that still need your review on the Quotes page." : "Waiting for the buyer: some extracted values are not reviewed yet.", owner ? L(r.quotes()) : L(r.approval()));
  const diffs = s.comparison ? s.comparison.summary.differences + s.comparison.summary.open : 0;
  // .7: the rule check is not blocked → the step is decided by the actual assignment / approval state first.
  if (e && e.status !== "BLOCKED" && active) return activeStep();
  if (e && e.status !== "BLOCKED" && !active) {
    const open = diffs > 0 || unresolved.length > 0 ? ` Open points remain (${diffs} on the Compare page${unresolved.length ? `, questions ${unresolved.map((q) => `Q${q.number}`).join(", ")}` : ""}); clarifying them is the buyer's choice.` : "";
    if (!owner) return step(`You can review and approve this version on the approval page; confirm each listed item when approving.${open}`, L(r.approval()));
    if (!s.approverAssigned) return step(`Assign an approver on the request page (Access). Only that approver can approve.${open}`, L(r.access()));
    return step(`Waiting for the approver: nothing is approved yet.${open}`, L(r.approval()));
  }
  if (diffs > 0 && s.drafts.length === 0)
    return step(owner ? `Look at the ${diffs} differences / open points on the Compare page and create a clarification draft if you need the supplier's answer.` : "Waiting for the buyer: differences with the request are not clarified yet.", owner ? L(r.compare()) : L(r.approval()));
  if (unresolved.length > 0)
    return step(owner ? `Questions still open in draft ${shortDraftRef(s.drafts[0].id)}: ${unresolved.map((q) => `Q${q.number}`).join(", ")}. Record the supplier's replies on the draft page.` : "Waiting for the buyer: questions to the supplier are still open.", owner ? L(r.draft(s.drafts[0].id)) : L(r.approval()));
  if (needsQuote) return step(owner ? "A reply proposes new terms: save the supplier's updated quote as a new version on the Quotes page." : "Waiting for the buyer: an updated quote is needed.", owner ? L(r.quotes()) : L(r.approval()));
  if (!e || e.status === "BLOCKED") return step("The approval check is blocked; see the blocking reasons on the approval page.", L(r.approval()));
  if (owner && !s.approverAssigned && !active) return step("Assign an approver on the request page (Access). Only that approver can approve.", L(r.access()));
  if (!active) return step(owner ? "Waiting for the approver: nothing is approved yet." : "You can review and approve this version on the approval page.", L(r.approval()));
  return activeStep();
}

// ---------- per intent ----------

export function buildCopilot(src: CopilotSources, principal: Principal, requestId: string, sel: Selection, intent: CopilotIntent): Built | null {
  const s = gather(src, principal, requestId, sel);
  if (!s) return null;
  const b = new Bundle();
  const r = routes(s);
  const L = (x: readonly [string, string] | null) => (x ? b.link(x[0], x[1]) : null);
  header(b, s);
  if (s.versionId) {
    switch (intent) {
      case "DIFFERENCES": {
        if (!s.comparison) {
          if (s.compareRefusal) b.add(`The comparison was refused for this run (${s.compareRefusal}).`, ["NOT_AVAILABLE"], { versionId: s.versionId }, true, { key: "COMPARE_REFUSED" });
        } else {
          const c = s.comparison;
          const rows = c.rows.filter((x) => x.outcome === "DIFFERENCE" || x.outcome === "OPEN");
          b.add(`Comparison of version ${c.binding.version.versionNumber} with request revision ${c.binding.snapshotRevision}: ${c.summary.differences} differences, ${c.summary.open} open points, ${c.summary.matches} matches.`, ["DIFFERENCE"], {
            versionId: c.binding.version.id,
            runId: c.binding.run.id,
            snapshotRevision: c.binding.snapshotRevision,
          }, true, { key: "DIFF_SUMMARY" });
          for (const row of rows) b.add(rowText(c, row), row.outcome === "DIFFERENCE" ? ["DIFFERENCE", "MUST_CITE"] : ["DIFFERENCE"], { versionId: c.binding.version.id, runId: c.binding.run.id, row: row.key, reviewId: row.quote[0]?.reviewId ?? null }, true, { key: `ROW:${row.key}` });
          L(r.compare());
        }
        quoteText(b, s);
        break;
      }
      case "WHY_NOT_APPROVABLE":
        gateFacts(b, s, "ALL");
        approvalFacts(b, s);
        L(r.approval());
        if (s.role === "OWNER" && !s.approverAssigned) L(r.access());
        quoteText(b, s);
        break;
      case "AFTER_REPLY":
        draftFacts(b, s, true);
        // System boundary as a citable rule fact (tagged APPROVAL so a sentence citing it may mention approval; a positive
        // "is approved" still needs an Active approval fact — nothing is relaxed for amounts or states).
        if (s.drafts.length > 0) b.add(RULE_ANSWERED_NOT_APPROVED, ["RULE", "APPROVAL"], { rule: "ANSWERED_NOT_APPROVED" }, true, { key: "RULE_ANSWERED_NOT_APPROVED" });
        if (s.drafts.length > 0) L(r.draft(s.drafts[0].id));
        break;
      case "PAYMENT_AMOUNT":
        // Owner, 2 Nov night: a payment answer must state the check status (incl. open confirmations) and whether a
        // valid approval exists — not only the amount.
        gateFacts(b, s, "STATUS", true);
        moneyFacts(b, s);
        approvalFacts(b, s, true);
        paymentFacts(b, s);
        L(r.approval());
        quoteText(b, s);
        break;
      case "NEXT_STEP":
        gateFacts(b, s, "BLOCKS");
        approvalFacts(b, s);
        paymentFacts(b, s);
        if (s.drafts.length > 0) draftFacts(b, s, false);
        break;
    }
  } else L(r.quotes());
  const next = nextStep(b, s);
  if (intent === "NEXT_STEP") b.add(`Next step (TradeProof's fixed rules): ${next.text}`, ["NEXT_STEP"], { link: next.link }, true, { key: "NEXT_STEP" });
  return {
    facts: b.facts,
    links: b.links,
    nextStep: next,
    notices: intent === "AFTER_REPLY" && s.versionId ? [RULE_ANSWERED_NOT_APPROVED] : [],
    basis: basisOf(s),
    resolved: {
      seriesId: s.current?.id ?? null,
      versionId: s.versionId,
      runId: s.entry?.kind === "PREVIEW" ? s.entry.run.id : null,
      baseRunId: s.entry?.kind === "PREVIEW" ? (s.entry.baseRun?.id ?? null) : null,
    },
  };
}

/** Basis only (no facts sent anywhere): for the panel's focus / manual check. null = not readable or not existing. */
export function basisFor(src: CopilotSources, principal: Principal, requestId: string, sel: Selection): { basis: CopilotBasis; resolved: Resolved } | null {
  const built = buildCopilot(src, principal, requestId, sel, "NEXT_STEP");
  return built ? { basis: built.basis, resolved: built.resolved } : null;
}
