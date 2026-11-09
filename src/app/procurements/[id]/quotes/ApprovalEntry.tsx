"use client";

// Decision summary for the quote version selected on the Quotes page (31 Oct entry; reshaped 5 Nov). Placed at the top
// of the version view. It READS ONLY: the run choices (GET comparison), the server's approval preview for exactly this
// version and run (GET approvals?series&version&run — computing a preview writes nothing) and this version's approvals
// with their payment records (GET approvals?statusFor — validity computed without any write). It shows:
//   1. three separate status cells — rule check · approval · payment — each with a word, never colour alone;
//   2. the first one or two reasons with the two values side by side and the quote's source line (link to it);
//      the rest behind "Show N more";
//   3. one next step for the viewer's role.
// It decides nothing: blocked / approvable / payable are the server's answers, and approving and paying happen on the
// approval page as before. The assigned approver gets the way to approve; the owning buyer never an approve control.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  approvalEntry,
  decisionView,
  type ApprovalEntry as Entry,
  type Decision,
  type DecisionApproval,
  type EntryChoices,
  type EntryRole,
  type NextAction,
} from "@/lib/approval-entry";
import type { Evaluation, Finding, SnapshotValue } from "@/server/approval/evaluate";
import { en } from "@/i18n/en";
import { findingText, pathFor } from "./finding-text";
import { utc } from "./QuoteParts";

const t = en.approval.quotesEntry;
const d = t.decision;
const refusalText = (code: string) => en.comparison.refusals[code] ?? code;
const short = (id: string) => `${id.slice(0, 11)}…`;
const amountOf = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

type PayMode = "OFF" | "SANDBOX" | "MOCK" | "REFUSED";
type Approvals = "loading" | "error" | { here: DecisionApproval[]; otherActive: DecisionApproval[] };
type Preview = "loading" | "error" | Evaluation;
type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; choices: EntryChoices };

/** Which stored value a finding is about, so its quote excerpt can be shown (display mapping only, no rule). */
const TERM_OF: Record<string, keyof Evaluation["snapshot"]["terms"]> = {
  TOTAL_DIFFERS_FROM_LINES: "total",
  CANNOT_CHECK_TOTAL: "total",
  OVER_BUDGET: "total",
  ABOVE_SANDBOX_CEILING: "total",
  CURRENCY_NOT_PAYABLE: "currency",
  SEVERAL_CURRENCIES: "currency",
  PAYMENT_TERMS_DIFFER: "paymentTerms",
  PAYMENT_TERMS_BY_EYE: "paymentTerms",
  STAGED_PAYMENT: "paymentTerms",
  TERMS_NOT_SETTLED: "paymentTerms",
  LEAD_TIME_TOO_LATE: "leadTime",
  LEAD_TIME_UNVERIFIABLE: "leadTime",
  INCOTERM_DIFFERS: "incoterm",
  INCOTERM_NOT_SETTLED: "incoterm",
  INCOTERM_BY_EYE: "incoterm",
};

function itemOf(f: Finding, snap: Evaluation["snapshot"]) {
  // Item findings have the subject "<request line id>:<source>:<quote item index>".
  const [lineId, source, index] = f.subject.split(":");
  return snap.items.find((i) => i.requestItemId === lineId && i.quote.source === source && String(i.quote.index) === index) ?? null;
}

function evidenceOf(f: Finding, snap: Evaluation["snapshot"]): SnapshotValue | null {
  if (f.code === "QTY_DIFFERS") return itemOf(f, snap)?.quote.quantity ?? null;
  if (f.code === "UNIT_DIFFERS") return itemOf(f, snap)?.quote.unit ?? null;
  const term = TERM_OF[f.code];
  return term ? (snap.terms[term] ?? null) : null;
}

/** Line number (1-based) of the first line of this version's text that contains the excerpt, or null. */
function lineOf(rawText: string, excerpt: string | null): number | null {
  const want = (excerpt ?? "").split(/\r\n|\r|\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!want) return null;
  const i = rawText.split(/\r\n|\r|\n/).findIndex((l) => l.includes(want));
  return i >= 0 ? i + 1 : null;
}

function SideBySide({ f, snap }: { f: Finding; snap: Evaluation["snapshot"] }) {
  let pair: [string, string, string, string] | null = null;
  if (f.code === "QTY_DIFFERS" || f.code === "UNIT_DIFFERS") {
    const it = itemOf(f, snap);
    const unit = f.code === "QTY_DIFFERS" ? { req: it?.request.unit ?? "", quote: it?.quote.unit.value ?? "" } : { req: "", quote: "" };
    pair = [d.requestSide, `${f.args.wanted ?? "—"} ${unit.req}`.trim(), d.quoteSide, `${f.args.quoted ?? "—"} ${unit.quote}`.trim()];
  } else if (f.code === "TOTAL_DIFFERS_FROM_LINES") {
    pair = [d.linesSide, f.args.sum ?? "—", d.totalSide, f.args.total ?? "—"];
  } else if (f.code === "OVER_BUDGET") {
    pair = [d.requestSide, f.args.budget ?? "—", d.quoteSide, f.args.total ?? "—"];
  } else if ((f.code === "PAYMENT_TERMS_DIFFER" || f.code === "INCOTERM_DIFFERS" || f.code === "KEY_ATTRIBUTE_DIFFERS") && f.args.quoted) {
    pair = [d.requestSide, f.args.wanted ?? f.args.required ?? "—", d.quoteSide, f.args.quoted];
  }
  if (!pair) return null;
  return (
    <dl className="vs" data-testid="decision-vs">
      <div>
        <dt>{pair[0]}</dt>
        <dd className="num">{pair[1]}</dd>
      </div>
      <div>
        <dt>{pair[2]}</dt>
        <dd className="num">{pair[3]}</dd>
      </div>
    </dl>
  );
}

function Reason({ f, snap, rawText }: { f: Finding; snap: Evaluation["snapshot"]; rawText: string }) {
  const ev = evidenceOf(f, snap);
  const line = ev ? lineOf(rawText, ev.excerpt) : null;
  const todo = pathFor(f);
  return (
    <li className="reason" data-code={f.code} data-level={f.level}>
      <p className="reason-text">{findingText(f)}</p>
      <SideBySide f={f} snap={snap} />
      {ev ? (
        ev.excerpt ? (
          <p className="small evidence" data-testid="decision-evidence">
            <span className="muted">{line ? d.evidence(line) : d.evidenceNoLine}</span> <q className="pre">{ev.excerpt}</q>
            {line ? (
              <>
                {" "}
                <a href={`#quote-line-${line}`} data-testid="decision-evidence-link">
                  {d.showLine}
                </a>
              </>
            ) : null}
          </p>
        ) : (
          <p className="small muted">{d.noEvidence}</p>
        )
      ) : null}
      {todo ? (
        <p className="small muted">
          {en.approval.whatToDo} {todo}
        </p>
      ) : null}
    </li>
  );
}

/** Shape + word for each state, so nothing depends on colour. */
const MARK: Record<string, string> = { bad: "✕", warn: "!", ok: "✓", none: "○", wait: "…" };

function Cell({ name, tone, text, testid, state }: { name: string; tone: "bad" | "warn" | "ok" | "none" | "wait"; text: string; testid: string; state: string }) {
  return (
    <div className={`cell tone-${tone}`} data-testid={testid} data-state={state}>
      <dt>{name}</dt>
      <dd>
        <span className="mark" aria-hidden="true">
          {MARK[tone]}
        </span>{" "}
        {text}
      </dd>
    </div>
  );
}

function cells(dec: Decision) {
  const c = dec.check;
  const check =
    c.kind === "BLOCKED"
      ? { tone: "bad" as const, text: d.check.BLOCKED(c.count) }
      : c.kind === "READY_WITH_CONFIRMATIONS"
        ? { tone: "warn" as const, text: d.check.READY_WITH_CONFIRMATIONS(c.count) }
        : c.kind === "READY"
          ? { tone: "ok" as const, text: d.check.READY }
          : c.kind === "PAID_NO_NEW_APPROVAL"
            ? { tone: "none" as const, text: d.check.PAID_NO_NEW_APPROVAL }
          : c.kind === "NOT_CHECKED"
            ? { tone: "none" as const, text: d.check.NOT_CHECKED }
            : { tone: "wait" as const, text: c.kind === "LOADING" ? d.check.LOADING : d.check.ERROR };
  const a = dec.approval;
  const approval =
    a.kind === "ACTIVE"
      ? { tone: "ok" as const, text: d.approval.ACTIVE }
      : a.kind === "OTHER"
        ? { tone: "none" as const, text: d.approval.OTHER(a.versions.map((v) => `version ${v}`).join(", ")) }
        : a.kind === "INVALIDATED" || a.kind === "REVOKED"
          ? { tone: "bad" as const, text: d.approval[a.kind] }
          : a.kind === "NONE"
            ? { tone: "none" as const, text: d.approval.NONE }
            : { tone: "wait" as const, text: a.kind === "LOADING" ? d.approval.LOADING : d.approval.ERROR };
  const p = dec.payment;
  const payment =
    p.kind === "PAID"
      ? { tone: "ok" as const, text: d.payment.PAID(d.envOfSku(p.sku)) }
      : p.kind === "OPEN"
        ? { tone: "warn" as const, text: d.payment.OPEN(p.status) }
        : p.kind === "FAILED"
          ? { tone: "bad" as const, text: d.payment.FAILED }
          : p.kind === "OTHER"
            ? { tone: "none" as const, text: d.payment.OTHER(p.versions.map((v) => `version ${v}`).join(", ")) }
            : p.kind === "NONE"
              ? { tone: "none" as const, text: d.payment.NONE }
              : { tone: "wait" as const, text: d.payment.LOADING };
  return { check, approval, payment };
}

export default function ApprovalEntry({
  requestId,
  seriesId,
  seriesName,
  versionId,
  role,
  approverAssigned,
  approverName,
  paymentMode,
  rawText,
  latestVersionId,
  onOpenVersion,
}: {
  requestId: string;
  seriesId: string;
  seriesName: string;
  versionId: string;
  role: EntryRole;
  /** Owner only: whether an approver is assigned now (null for the approver). */
  approverAssigned: boolean | null;
  /** Owner only: display name of the assigned approver (null if none / not the owner). */
  approverName: string | null;
  /** The server's payment switch for approval payments (read on the server; display only). */
  paymentMode: PayMode;
  /** This version's stored text — only used to find the line number of an excerpt. */
  rawText: string;
  latestVersionId: string;
  onOpenVersion: (seriesId: string, versionId: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ href: string; value: Preview } | null>(null);
  const [approvals, setApprovals] = useState<Approvals>("loading");

  useEffect(() => {
    let live = true;
    fetch(`/api/procurements/${requestId}/quotes/${seriesId}/versions/${versionId}/comparison`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as { choices?: EntryChoices; message?: string } | null;
        return res.ok && data?.choices ? ({ kind: "ready", choices: data.choices } as const) : ({ kind: "error", message: data?.message ?? `HTTP ${res.status}` } as const);
      })
      .catch(() => ({ kind: "error", message: "Could not reach the local server." }) as const)
      .then((next) => {
        if (live) setLoaded(next);
      });
    return () => {
      live = false;
    };
  }, [requestId, seriesId, versionId, attempt]);

  useEffect(() => {
    let live = true;
    fetch(`/api/procurements/${requestId}/approvals?statusFor=${versionId}`, { cache: "no-store" })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as { here?: DecisionApproval[]; otherActive?: DecisionApproval[] } | null;
        return res.ok && j?.here && j.otherActive ? { here: j.here, otherActive: j.otherActive } : ("error" as const);
      })
      .catch(() => "error" as const)
      .then((next) => {
        if (live) setApprovals(next);
      });
    return () => {
      live = false;
    };
  }, [requestId, versionId, attempt]);

  const e: Entry | null = loaded.kind === "ready" ? approvalEntry({ requestId, seriesId, versionId }, loaded.choices, role, approverAssigned, chosen) : null;
  const previewHref = e?.kind === "PREVIEW" ? e.href : null;

  useEffect(() => {
    if (!previewHref) return;
    let live = true;
    // Same ids as the approval page link; the API's GET preview computes and stores nothing.
    const q = new URL(previewHref, window.location.origin).search;
    fetch(`/api/procurements/${requestId}/approvals${q}`, { cache: "no-store" })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as { evaluation?: Evaluation } | null;
        return res.ok && j?.evaluation ? j.evaluation : ("error" as const);
      })
      .catch(() => "error" as const)
      .then((value) => {
        if (live) setPreview({ href: previewHref, value });
      });
    return () => {
      live = false;
    };
  }, [requestId, previewHref, attempt]);

  const retry = () => {
    setLoaded({ kind: "loading" });
    setApprovals("loading");
    setPreview(null);
    setAttempt((n) => n + 1);
  };

  if (loaded.kind === "loading" || !e) {
    if (loaded.kind === "error") {
      return (
        <section className="card alert error-box decision" data-testid="quote-approval-entry" data-state="error" role="alert">
          <h3>{t.heading}</h3>
          <p className="small">
            {t.loadFailed(loaded.message)}{" "}
            <button type="button" onClick={retry}>
              {t.retry}
            </button>
          </p>
        </section>
      );
    }
    return (
      <section className="card decision" data-testid="quote-approval-entry" data-state="loading" aria-busy="true">
        <h3>{t.heading}</h3>
        <p className="small muted">{t.loading}</p>
      </section>
    );
  }

  const ev: Preview | null = e.kind === "PREVIEW" ? (preview && preview.href === e.href ? preview.value : "loading") : null;
  const evaluation = ev && ev !== "loading" && ev !== "error" ? ev : null;
  const dec = decisionView({
    role,
    approverAssigned,
    versionNumber: e.versionNumber,
    latestVersionNumber: e.latestVersionNumber,
    evaluation: ev === null ? null : ev === "loading" || ev === "error" ? ev : { status: ev.status, findings: ev.findings },
    approvals,
  });
  const cv = cells(dec);
  const level = evaluation?.status === "BLOCKED" ? "BLOCK" : evaluation?.status === "READY_WITH_CONFIRMATIONS" ? "CONFIRM" : null;
  const reasons = evaluation && level ? evaluation.findings.filter((f) => f.level === level) : [];
  const shown = reasons.slice(0, 2);
  const more = reasons.slice(2);
  const confirmCount = evaluation ? evaluation.findings.filter((f) => f.level === "CONFIRM").length : 0;
  const latestNumber = e.latestVersionNumber;
  const compareHref = `/procurements/${requestId}/quotes/compare?series=${seriesId}&version=${versionId}${e.kind === "PREVIEW" ? `&run=${e.run.id}${e.baseRun ? `&baseRun=${e.baseRun.id}` : ""}` : ""}#clarification`;
  const activeApproval = dec.approval.kind === "ACTIVE" || dec.approval.kind === "OTHER" ? dec.approval.approval : null;
  const approvalPageOf = (a: DecisionApproval) => `/procurements/${requestId}/quotes/approval?series=${a.seriesId}&version=${a.versionId}&run=${a.runId}#approval-history`;
  const amount = evaluation?.amount ? amountOf(evaluation.amount.minor, evaluation.amount.currency) : null;

  const nextText = (() => {
    if (!dec.next) return null;
    const k = dec.next.key;
    const nx = d.next;
    const other = activeApproval ? `Version ${activeApproval.versionNumber}` : "";
    switch (k) {
      case "OWNER_OLDER":
      case "APPROVER_OLDER":
        return nx[k](latestNumber);
      case "OWNER_WAITING":
        return nx.OWNER_WAITING(approverName ?? d.who.fallback, confirmCount);
      case "OWNER_PAY_OPEN":
        return nx.OWNER_PAY_OPEN(dec.payment.kind === "OPEN" ? dec.payment.status : "");
      case "OWNER_OTHER_ACTIVE":
      case "APPROVER_OTHER_ACTIVE":
        return nx[k](other);
      case "APPROVER_BLOCKED":
        return nx.APPROVER_BLOCKED(dec.check.kind === "BLOCKED" ? dec.check.count : 0);
      case "APPROVER_REVIEW":
        return nx.APPROVER_REVIEW(confirmCount);
      default:
        return nx[k];
    }
  })();

  const actionEl = (a: NextAction | null, primary: boolean) => {
    if (!a) return null;
    const cls = primary ? "button primary" : "button";
    switch (a) {
      case "clarify":
        return (
          <Link href={compareHref} prefetch={false} className={cls} data-testid="decision-clarify">
            {d.action.clarify}
          </Link>
        );
      case "request":
        return (
          <Link href={`/procurements/${requestId}`} prefetch={false} className={cls}>
            {d.action.request}
          </Link>
        );
      case "assign":
        return (
          <Link href={`/procurements/${requestId}#access`} prefetch={false} className={cls} data-testid="decision-assign">
            {d.action.assign}
          </Link>
        );
      case "approve":
        return e.kind === "PREVIEW" ? (
          <Link href={`${e.href}#approval-status`} prefetch={false} className={cls} data-testid="entry-approve-link">
            {d.action.approve}
          </Link>
        ) : null;
      case "pay":
      case "payment":
        return activeApproval ? (
          <Link href={approvalPageOf(activeApproval)} prefetch={false} className={cls} data-testid="decision-pay">
            {a === "pay" ? d.action.pay : d.action.payment}
          </Link>
        ) : dec.payment.kind === "PAID" && approvals !== "loading" && approvals !== "error" && approvals.here[0] ? (
          <Link href={approvalPageOf(approvals.here.find((x) => x.payment?.status === "PAID") ?? approvals.here[0])} prefetch={false} className={cls} data-testid="decision-pay">
            {d.action.payment}
          </Link>
        ) : null;
      case "latest":
        return latestVersionId !== versionId ? (
          <button type="button" className={primary ? "primary" : undefined} onClick={() => onOpenVersion(seriesId, latestVersionId)} data-testid="decision-open-latest">
            {d.action.latest(latestNumber)}
          </button>
        ) : null;
      case "otherVersion":
        return activeApproval ? (
          <button type="button" className={primary ? "primary" : undefined} onClick={() => onOpenVersion(activeApproval.seriesId, activeApproval.versionId)} data-testid="decision-open-other">
            {d.action.otherVersion(`version ${activeApproval.versionNumber}`)}
          </button>
        ) : null;
      case "extraction":
        return (
          <a href="#extraction" className={cls}>
            {d.action.extraction}
          </a>
        );
    }
  };

  const older = e.versionNumber < e.latestVersionNumber;
  const settled = approvals !== "loading" && ev !== "loading";
  // The approver's "Review and approve" action already links to the preview; the owner keeps a plain link to it.
  const showFootLink = dec.next?.primary !== "approve" || role !== "APPROVER";
  return (
    <section
      className="card decision"
      data-testid="quote-approval-entry"
      // 5 Nov: "preview" / "no-run" only once every read has answered (choices, approvals, preview), so nothing moves
      // under a click that waited for this state; until then the section says it is still loading.
      data-state={settled ? (e.kind === "PREVIEW" ? "preview" : "no-run") : "loading"}
      aria-busy={!settled}
      data-role={role}
      data-run={e.kind === "PREVIEW" ? e.run.id : undefined}
      data-check={dec.check.kind}
      data-approval={dec.approval.kind}
      data-payment={dec.payment.kind}
      aria-labelledby="decision-heading"
    >
      <div className="decision-head">
        <h3 id="decision-heading">
          {d.heading(e.versionNumber, e.latestVersionNumber)} <span className="muted small pre">· {seriesName}</span>
        </h3>
        <span className={`pay-env env-${paymentMode}`} data-testid="decision-pay-env">
          {d.payEnv[paymentMode]}
        </span>
      </div>
      <p className={`small ${older ? "unsaved" : "muted"}`} data-testid="decision-version-note">
        {older ? d.olderNote(e.versionNumber, e.latestVersionNumber) : d.latestNote}
      </p>

      <dl className="decision-strip" aria-label={t.heading}>
        <Cell name={d.cells.check} tone={cv.check.tone} text={cv.check.text} testid="decision-check" state={dec.check.kind} />
        <Cell name={d.cells.approval} tone={cv.approval.tone} text={cv.approval.text} testid="entry-approval-state" state={dec.approval.kind === "NONE" ? "NONE" : dec.approval.kind === "OTHER" ? "NONE" : dec.approval.kind} />
        <Cell name={d.cells.payment} tone={cv.payment.tone} text={cv.payment.text} testid="decision-payment" state={dec.payment.kind} />
      </dl>
      {amount ? <p className="small amount-line" data-testid="decision-amount">{activeApproval && dec.approval.kind === "ACTIVE" ? d.amountApproved(amountOf(activeApproval.amountMinor, activeApproval.currency)) : d.amountLine(amount)}</p> : null}

      {nextText ? (
        <div className="decision-next" data-testid="decision-next" data-next={dec.next!.key}>
          <p>
            <strong>{d.nextHeading}:</strong> {nextText}
          </p>
          <p className="decision-actions">
            {actionEl(dec.next!.primary, true)} {actionEl(dec.next!.secondary, false)}
          </p>
        </div>
      ) : null}
      {e.kind === "NO_USABLE_RUN" ? (
        <div className="decision-reasons">
          <h4>{t.noRunTitle}</h4>
          {e.refused.length === 0 ? (
            <p className="small">{t.noRunNone}</p>
          ) : (
            <ul className="small" data-testid="entry-refusals">
              {e.refused.map((r) => (
                <li key={r.runId} data-refusal={r.refusal}>
                  {t.refusedLine(short(r.runId), refusalText(r.refusal))}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : dec.approval.kind === "ACTIVE" && level === "CONFIRM" ? (
        <p className="small muted" data-testid="decision-confirmed-note">{d.confirmedInApproval}</p>
      ) : shown.length > 0 && evaluation ? (
        <div className="decision-reasons" data-testid="decision-reasons">
          <h4>{dec.check.kind === "PAID_NO_NEW_APPROVAL" ? d.reasonsHeading.PAID : d.reasonsHeading[level!]}</h4>
          <ol className="reasons">
            {shown.map((f) => (
              <Reason key={f.key} f={f} snap={evaluation.snapshot} rawText={rawText} />
            ))}
          </ol>
          {more.length > 0 ? (
            <details className="more-reasons" data-testid="decision-more">
              <summary>{d.moreReasons(more.length)}</summary>
              <ol className="reasons" start={3}>
                {more.map((f) => (
                  <Reason key={f.key} f={f} snap={evaluation.snapshot} rawText={rawText} />
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      ) : ev === "error" ? (
        <p className="small unsaved">
          {t.loadFailed("preview")}{" "}
          <button type="button" onClick={retry}>
            {t.retry}
          </button>
        </p>
      ) : null}


      {role === "OWNER" && approverAssigned === false ? (
        <p className="small unsaved" data-testid="entry-no-approver">
          {t.noApprover} <Link href={`/procurements/${requestId}#access`}>{t.noApproverLink}</Link>
        </p>
      ) : null}

      <div className="decision-foot small">
        {e.kind === "PREVIEW" ? (
          <>
            {showFootLink ? (
              <Link href={e.href} prefetch={false} data-testid={role === "APPROVER" ? "entry-approve-link" : "entry-status-link"}>
                {role === "APPROVER" ? t.approverLink : d.fullPreview}
              </Link>
            ) : null}
            <span className="muted" data-testid="entry-run">
              {showFootLink ? " · " : ""}
              {t.runLine(utc(e.run.startedAt), e.run.mode, e.run.model, short(e.run.id))}
            </span>
            {e.otherRuns.length > 0 ? (
              <label className="small block">
                {t.runChoose}{" "}
                <select value={e.run.id} onChange={(ev2) => setChosen(ev2.target.value)} data-testid="entry-run-select">
                  {[e.run, ...e.otherRuns]
                    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {utc(r.startedAt)} · {r.mode} · {r.model} · {short(r.id)}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {e.baseRun && e.baseVersionNumber !== null ? <span className="block">{t.baseLine(e.baseVersionNumber, utc(e.baseRun.startedAt), short(e.baseRun.id))}</span> : null}
            {e.baseMissing ? (
              <span className="block unsaved" data-testid="entry-base-missing">
                {t.baseMissing(e.baseVersionNumber === null ? "?" : String(e.baseVersionNumber))}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span>{role === "OWNER" ? t.noRunOwner : t.noRunApprover}</span>{" "}
            <Link href={e.historyHref} prefetch={false} data-testid="entry-history-link">
              {t.historyLink}
            </Link>
          </>
        )}{" "}
        <button type="button" className="link-button neutral" onClick={retry} data-testid="entry-recheck">
          {t.retry}
        </button>
        {activeApproval ? (
          <span className="block muted">
            {dec.approval.kind === "ACTIVE" ? t.stateActive(utc(activeApproval.createdAt), amountOf(activeApproval.amountMinor, activeApproval.currency), short(activeApproval.id)) : t.stateOther(`version ${activeApproval.versionNumber}`)}{" "}
            <Link href={approvalPageOf(activeApproval)} prefetch={false} data-testid="entry-approval-details">
              {t.stateDetails}
            </Link>
          </span>
        ) : null}
        <span className="block hint">{t.stateNote}</span>
      </div>
    </section>
  );
}
