import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EXTRACTION_RUN_ID } from "@/lib/extraction";
import { moneyPanelView, recordedHeading, type PayEnv } from "@/lib/money-panel";
import { paymentKind, paymentLabels } from "@/lib/payment-labels";
import { shortItemRef, shortProcurementId } from "@/lib/procurement";
import { CONTENT_KIND_LABELS, QUOTE_SERIES_ID, QUOTE_VERSION_ID, shortSeriesId } from "@/lib/quote-versions";
import { en } from "@/i18n/en";
import { canApproveRequest, canPayRequest, canReadRequest, canRevokeApproval, canWriteRequest } from "@/server/access/policy";
import { currentApprovalPaymentMode, getApprovalService } from "@/server/approval";
import type { FeeEntry, SnapshotValue } from "@/server/approval/evaluate";
import { findingText, pathFor } from "../finding-text";
import { getComparisonService } from "@/server/comparison";
import { getPublicPayPalConfig } from "@/server/payments";
import { getProcurementStore } from "@/server/procurement";
import { PROCUREMENT_ID } from "@/server/procurement/store";
import { getQuoteStore } from "@/server/quotes";
import { requireSignedInPage } from "../../../local-only";
import { ApproveForm, RequirementCard, RevokeForm } from "./ApprovalActions";
import { PaymentPanel, type PanelPayment } from "./PaymentPanel";

// Approval page (29 Oct). Server-rendered from stored records on every request: the preview is computed, never stored,
// and reading the page writes nothing except a terminal "no longer valid" event when an earlier approval's basis has
// changed. Rendering never calls a model or PayPal; payment steps run only when the user presses one, and only if the
// server's payment switch is on (payment-mode.ts).

export const metadata: Metadata = {
  title: "Approval — TradeProof",
  robots: { index: false, follow: false },
};

const t = en.approval;
const utc = en.common.utc;
type Search = Record<string, string | string[] | undefined>;


function href(requestId: string, seriesId: string, versionId: string, runId: string | null, baseRunId: string | null) {
  const q = new URLSearchParams({ series: seriesId, version: versionId });
  if (runId) q.set("run", runId);
  if (baseRunId) q.set("baseRun", baseRunId);
  return `/procurements/${requestId}/quotes/approval?${q.toString()}`;
}

export default async function ApprovalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const me = await requireSignedInPage("/procurements");
  const { id } = await params;
  const query = await searchParams;
  const pick = (k: string) => (typeof query[k] === "string" ? (query[k] as string) : null);
  const seriesId = pick("series");
  const versionId = pick("version");
  const runId = pick("run");
  const baseRunId = pick("baseRun");
  if (!PROCUREMENT_ID.test(id) || !seriesId || !versionId || !QUOTE_SERIES_ID.test(seriesId) || !QUOTE_VERSION_ID.test(versionId)) notFound();
  if ((runId && !EXTRACTION_RUN_ID.test(runId)) || (baseRunId && !EXTRACTION_RUN_ID.test(baseRunId))) notFound();
  if (!canReadRequest(me, id)) notFound();
  const record = getProcurementStore().get(id);
  const series = getQuoteStore().listSeries(id).find((s) => s.id === seriesId);
  if (!record || !series || !series.versions.some((v) => v.id === versionId)) notFound();

  // No run named: name the newest usable one (and the base's, for a supplement) in the address, as the comparison page does.
  if (!runId) {
    const c = getComparisonService().compare(me, id, seriesId, versionId, null, null);
    if (c.status === "NOT_FOUND") notFound();
    const first = c.choices.runs.find((r) => r.refusal === null)?.id ?? null;
    const base = c.choices.base?.runs.find((r) => r.refusal === null)?.id ?? null;
    if (first) redirect(href(id, seriesId, versionId, first, base));
  }

  const service = getApprovalService();
  const pre = runId ? service.preview(me, id, { seriesId, versionId, runId, baseRunId }) : null;
  const history = service.list(me, id) ?? [];
  // Validity as the server reads it now. The server allows one active approval per request, so while one exists no
  // Approve button is offered; when it is revoked or no longer valid, the button comes back (if the preview allows).
  const active = history.find((h) => h.validity.state === "ACTIVE") ?? null;
  const payMode = currentApprovalPaymentMode();
  const clientId = payMode.mode === "SANDBOX" ? getPublicPayPalConfig().clientId : null;
  const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
  const latest = series.versions[series.versions.length - 1];
  const compareHref = `/procurements/${id}/quotes/compare?series=${seriesId}&version=${versionId}${runId ? `&run=${runId}` : ""}${baseRunId ? `&baseRun=${baseRunId}` : ""}`;

  // 7 Nov: who is looking, the payment state of the request and the classification history (all read-only).
  const youLine = canApproveRequest(me, id) ? t.you.APPROVER_ASSIGNED(me.displayName) : canWriteRequest(me, id) ? t.you.OWNER(me.displayName) : t.you.OTHER(me.displayName);
  const allPayments = history.flatMap((h) => h.payments.map((p) => ({ ...p, approvalId: h.approval.id, versionId: h.approval.versionId, versionNumber: h.approval.snapshot.quote.versionNumber })));
  // Payment facts of the version on this page; a payment of another version is named as such, never shown as this one's.
  const paidAny = allPayments.find((p) => p.status === "PAID") ?? null;
  const paidRecord = paidAny && paidAny.versionId === versionId ? paidAny : null;
  const paidOther = paidAny && paidAny.versionId !== versionId ? paidAny : null;
  const openRecord = allPayments.find((p) => p.status !== "PAID" && p.status !== "FAILED") ?? null;
  // 9 Nov (later): a FAILED record is named in the Money panel (only when nothing is paid or open), never as paid.
  const failedRecord = !paidAny && !openRecord ? (allPayments.find((p) => p.status === "FAILED") ?? null) : null;
  const classHistory = service.classificationHistory(me, id, versionId) ?? [];
  const qe = en.approval.quotesEntry.decision;

  return (
    <main className="page wide approval-page">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">Procurement requests</Link> / <Link href={`/procurements/${id}`}>{shortProcurementId(id)}</Link> /{" "}
        <Link href={`/procurements/${id}/quotes?series=${seriesId}&version=${versionId}`}>Quotes</Link> / <Link href={compareHref}>{en.comparison.crumb}</Link> / {t.crumb}
      </p>
      <header className="page-head">
        <h1>
          {t.title} <span lang="zh-CN">{t.titleZh}</span>
        </h1>
        <p className="page-subject">{record.title}</p>
        <p className="small muted" data-testid="you-line">
          {youLine}
        </p>
      </header>
      <p className="card alert warn" data-testid="demo-banner">
        {t.demoBanner}
      </p>

      {!pre || pre.status !== "OK" ? (
        <section className="card alert warn" data-testid="approval-no-run">
          <p>{en.comparison.noRuns}</p>
        </section>
      ) : (
        (() => {
          const e = pre.evaluation;
          const s = e.snapshot;
          const blocks = e.findings.filter((f) => f.level === "BLOCK");
          const confirms = e.findings.filter((f) => f.level === "CONFIRM");
          const classifyCodes = new Set(["REQUIREMENT_NOT_CLASSIFIED", "KEY_REQUIREMENT_NOT_QUOTED", "KEY_REQUIREMENT_IN_QUOTE", "REQUIREMENT_NOT_KEY"]);
          const infos = e.findings.filter((f) => f.level === "INFO" && !classifyCodes.has(f.code));
          const requirementFindings = e.findings.filter((f) => classifyCodes.has(f.code));
          const subjects = [...new Map(requirementFindings.map((f) => [f.subject, f])).values()];
          const checkCell =
            paidRecord && e.status === "BLOCKED" && blocks.every((f) => f.code === "ALREADY_PAID")
              ? { tone: "ok", text: qe.check.PAID_NO_NEW_APPROVAL, state: "PAID_NO_NEW_APPROVAL" }
              : e.status === "BLOCKED"
                ? { tone: "bad", text: qe.check.BLOCKED(blocks.length), state: "BLOCKED" }
                : e.status === "READY_WITH_CONFIRMATIONS"
                  ? { tone: "warn", text: qe.check.READY_WITH_CONFIRMATIONS(confirms.length), state: "READY_WITH_CONFIRMATIONS" }
                  : { tone: "ok", text: qe.check.READY, state: "READY" };
          const approvalCell = active
            ? active.approval.versionId === versionId
              ? { tone: "ok", text: qe.approval.ACTIVE, state: "ACTIVE" }
              : { tone: "none", text: qe.approval.OTHER(`v${active.approval.snapshot.quote.versionNumber}`), state: "OTHER" }
            : history.length > 0
              ? { tone: "none", text: history[0].validity.state === "REVOKED" ? qe.approval.REVOKED : qe.approval.INVALIDATED, state: "NONE" }
              : { tone: "none", text: qe.approval.NONE, state: "NONE" };
          const paymentCell = paidRecord
            ? { tone: "ok", text: qe.payment.PAID(qe.envOfSku(paidRecord.sku)), state: "PAID" }
            : paidOther
              ? { tone: "none", text: qe.payment.OTHER(`v${paidOther.versionNumber}`), state: "OTHER" }
              : openRecord
              ? { tone: "warn", text: qe.payment.OPEN(openRecord.status), state: "OPEN" }
              : { tone: "none", text: qe.payment.NONE, state: "NONE" };
          const approvedHere = !!active && active.approval.versionId === versionId;
          return (
            <>
              <section className="card sheet" aria-labelledby="sheet-label" data-testid="conditions-sheet">
                <div className="sheet-top">
                  <div>
                    <p className="sheet-label" id="sheet-label">
                      {t.sheet.label}
                    </p>
                    <p className="sheet-version" data-testid="sheet-version">
                      {t.sheet.version(s.quote.versionNumber, s.quote.latestVersionNumber)}
                      {latest.id !== versionId ? (
                        <>
                          {" "}
                          · <Link href={href(id, seriesId, latest.id, null, null)}>v{latest.versionNumber} →</Link>
                        </>
                      ) : null}
                    </p>
                    <p className="small muted">
                      {series.name} · {t.sheet.request(s.request.revision)} · {t.sheet.run(s.runs.run.mode)}
                    </p>
                  </div>
                  <p className={`pay-env env-${payMode.mode === "REFUSED" ? "OFF" : payMode.mode}`} data-testid="sheet-pay-env">
                    {qe.payEnv[payMode.mode]}
                  </p>
                </div>
                <div className="sheet-body">
                  <div className="sheet-amount">
                    <p className="sheet-label">{t.sheet.amountLabel}</p>
                    {/* 7 Nov: paid record → its amount; Active approval of this version → the approved amount; otherwise the
                        preview's proposed amount. After a payment the fresh preview is blocked and has no amount. */}
                    {paidRecord ? (
                      <>
                        <p className="sheet-figure" data-testid="sheet-amount" data-kind="PAID">
                          {money(paidRecord.amountMinor, paidRecord.currency)}
                        </p>
                        <p className="small">{t.sheet.amountPaid(qe.envOfSku(paidRecord.sku))}</p>
                      </>
                    ) : approvedHere && active ? (
                      <>
                        <p className="sheet-figure" data-testid="sheet-amount" data-kind="APPROVED">
                          {active.approval.snapshot.money.thisPayment?.display ?? money(active.approval.amountMinor, active.approval.currency)}
                        </p>
                        <p className="small">{t.sheet.amountApproved}</p>
                      </>
                    ) : (
                      <>
                        <p className="sheet-figure" data-testid="sheet-amount" data-kind={s.money.thisPayment ? "PROPOSED" : "NONE"}>
                          {s.money.thisPayment ? s.money.thisPayment.display : t.sheet.amountNoneVersion(s.quote.versionNumber)}
                        </p>
                        {s.money.thisPayment ? (
                          <p className="small">{t.sheet.amountProposed}</p>
                        ) : (
                          // 9 Nov: say which version has no amount and why; another version's payment is named, never its amount as this one's.
                          <p className="small" data-testid="sheet-amount-none">
                            {e.status === "BLOCKED" ? t.sheet.amountNoneBlocked : null}
                            {paidOther ? <> {t.sheet.amountNonePaidOther(paidOther.versionNumber)}</> : null}
                          </p>
                        )}
                      </>
                    )}
                    {s.money.thisPayment || approvedHere || paidRecord ? <p className="small muted">{t.sheet.amountBasis}</p> : null}
                  </div>
                  <dl className="decision-strip sheet-strip" aria-label={t.sheet.label}>
                    <Cell name={qe.cells.check} tone={checkCell.tone} text={checkCell.text} testid="sheet-check" state={checkCell.state} />
                    <Cell name={qe.cells.approval} tone={approvalCell.tone} text={approvalCell.text} testid="sheet-approval" state={approvalCell.state} />
                    <Cell name={qe.cells.payment} tone={paymentCell.tone} text={paymentCell.text} testid="sheet-payment" state={paymentCell.state} />
                  </dl>
                </div>
              </section>

              <section className={`card anchor-target decision-panel ${e.status === "BLOCKED" ? "alert warn" : ""}`} id="approval-status" data-testid="approval-status" data-status={e.status} aria-labelledby="decision-heading">
                <h2 id="decision-heading">{t.sectionsHeading.decision}</h2>
                <p className="decision-status">{t.status[e.status]}</p>
                <p className="hint">{t.statusNote}</p>
                {blocks.length > 0 ? (
                  <>
                    <h3>{t.blockHeading}</h3>
                    <ul data-testid="block-list" className="finding-list">
                      {blocks.map((f) => (
                        <li key={f.key} data-code={f.code}>
                          {findingText(f)}
                          {pathFor(f) ? (
                            <span className="small muted block">
                              {t.whatToDo} {pathFor(f)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {confirms.length > 0 ? (
                  <>
                    <h3>{t.confirmHeading}</h3>
                    <p className="hint">{t.confirmNote}</p>
                    {!canApproveRequest(me, id) ? (
                      // 3 Nov: the buyer (and anyone who cannot approve) sees what the approver will have to confirm.
                      <>
                        <p className="small">{t.confirmReadonlyLead}</p>
                        <ul className="small finding-list" data-testid="confirm-list-readonly">
                          {confirms.map((f) => (
                            <li key={f.key}>{findingText(f)}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </>
                ) : null}
                {active ? (
                  <div className="approved-active" data-testid="approved-active" data-active-approval={active.approval.id} role="status">
                    <p>
                      <strong>{t.approvedActive}</strong>{" "}
                      <span className="small">
                        {t.historyLine(utc(active.approval.createdAt), active.approval.snapshot.quote.versionNumber, active.approval.snapshot.money.thisPayment?.display ?? money(active.approval.amountMinor, active.approval.currency))} · {t.actor}: {active.actorLabel}
                      </span>
                    </p>
                    {active.approval.versionId !== versionId || active.approval.runId !== runId ? <p className="small">{t.activeOtherBasis}</p> : null}
                    <p className="small">
                      {canApproveRequest(me, id) ? t.activeNoSecond : t.notApprover}{" "}
                      <a href="#approval-history" data-testid="approved-history-link">
                        {t.viewHistory}
                      </a>
                    </p>
                  </div>
                ) : canApproveRequest(me, id) ? (
                  <ApproveForm requestId={id} ids={{ seriesId, versionId, runId: runId!, baseRunId }} digest={e.digest} confirms={confirms.map((f) => ({ key: f.key, text: findingText(f) }))} blocked={e.status === "BLOCKED"} />
                ) : (
                  <p className="small" data-testid="approve-not-allowed">
                    {t.notApprover}
                  </p>
                )}
              </section>

              {renderHistory()}

              <section className="card" data-testid="approval-money">
                <h2>{t.moneyHeading}</h2>
                {(() => {
                  // 9 Nov: (a) a payment already made — its own amount, status, environment, payee; (b) what can be
                  // approved or paid now. Display only; amounts come from the stored records and the server preview.
                  const envOf = (sku: string) => qe.envOfSku(sku) as PayEnv;
                  const mv = moneyPanelView({
                    proposed: s.money.thisPayment?.display ?? null,
                    approvedHere: approvedHere && active ? (active.approval.snapshot.money.thisPayment?.display ?? money(active.approval.amountMinor, active.approval.currency)) : null,
                    paidHere: paidRecord ? { amount: money(paidRecord.amountMinor, paidRecord.currency), env: envOf(paidRecord.sku) } : null,
                    paidOther: paidOther ? { versionNumber: paidOther.versionNumber, amount: money(paidOther.amountMinor, paidOther.currency), env: envOf(paidOther.sku) } : null,
                    open: openRecord ? { status: openRecord.status, amount: money(openRecord.amountMinor, openRecord.currency), versionNumber: openRecord.versionNumber, env: envOf(openRecord.sku) } : null,
                    failed: failedRecord ? { amount: money(failedRecord.amountMinor, failedRecord.currency), versionNumber: failedRecord.versionNumber, env: envOf(failedRecord.sku) } : null,
                  });
                  const r = mv.recorded;
                  const n = mv.next;
                  return (
                    <>
                      <p data-testid="money-recorded" data-kind={r.kind} data-heading={recordedHeading(r)}>
                        <strong>{t.money.heading[recordedHeading(r)]}:</strong>{" "}
                        <span className="num">
                          {r.kind === "PAID_HERE"
                            ? t.money.recordedPaid(r.amount, r.env)
                            : r.kind === "PAID_OTHER"
                              ? t.money.recordedPaidOther(r.versionNumber, r.amount, r.env)
                              : r.kind === "OPEN"
                                ? t.money.recordedOpen(r.status, r.amount, r.versionNumber)
                                : r.kind === "FAILED"
                                  ? t.money.recordedFailed(r.amount, r.versionNumber)
                                  : t.money.recordedNone}
                        </span>
                      </p>
                      {r.kind !== "NONE" ? (
                        <p className="small" data-testid="money-recorded-facts">
                          {t.money.environment}: {t.money.envLabel[r.env]} · {t.money.payee}: {t.money.payeeValue}
                        </p>
                      ) : null}
                      <p data-testid="money-next" data-kind={n.kind}>
                        <strong>{t.money.nextLabel}:</strong>{" "}
                        {n.kind === "APPROVED" || n.kind === "PROPOSED" ? (
                          <>
                            <span data-testid="this-payment" className="num">
                              {n.amount}
                            </span>{" "}
                            — {t.money.next[n.kind]}
                          </>
                        ) : (
                          <span>{n.kind === "NONE_OPEN" ? t.money.next.NONE_OPEN(n.status) : t.money.next[n.kind]}</span>
                        )}
                      </p>
                      {n.kind === "APPROVED" || n.kind === "PROPOSED" ? (
                        <p className="small muted">
                          {t.money.basis} {t.money.payee}: {t.money.payeeValue}.
                        </p>
                      ) : null}
                    </>
                  );
                })()}
                <p className="small">
                  {t.money.goods}: {s.money.goodsSubtotal ?? "—"} · {t.money.stated}: {s.money.statedTotal ?? "—"}
                </p>
                <FeeList title={t.money.included} fees={s.money.included} id="fees-included" />
                <FeeList title={t.money.duplicates} fees={s.money.duplicates} id="fees-duplicates" hideEmpty />
                <FeeList title={t.money.notApplicable} fees={s.money.notApplicable} id="fees-na" hideEmpty />
                <FeeList title={t.money.excluded} fees={s.money.excluded} id="fees-excluded" />
                <FeeList title={t.money.unknown} fees={s.money.unknown} id="fees-unknown" />
                <FeeList title={t.money.unverified} fees={s.money.unverified} id="fees-unverified" />
                <p className="card alert" data-testid="landed-cost">
                  {t.money.landed}
                </p>
              </section>

              <section className="card" data-testid="approval-items">
                <h2>{t.itemsHeading}</h2>
                <div className="table-scroll">
                  <table className="small">
                    <thead>
                      <tr>
                        <th>{t.items.line}</th>
                        <th>{t.items.requested}</th>
                        <th>{t.items.quoted}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.items.map((i) => (
                        <tr key={`${i.requestItemId}-${i.quote.index}`}>
                          <td>
                            {i.name} <span className="muted">({shortItemRef(i.requestItemId)})</span>
                          </td>
                          <td>
                            {i.request.quantity ?? "—"} {i.request.unit ?? ""}
                            {i.request.material ? ` · ${i.request.material}` : ""}
                            {i.request.specification ? ` · ${i.request.specification}` : ""}
                            {i.request.customization ? ` · ${i.request.customization}` : ""}
                          </td>
                          <td>
                            <Val v={i.quote.quantity} /> <Val v={i.quote.unit} /> × <Val v={i.quote.unitPrice} />
                            {i.quote.lineSubtotal ? ` = ${i.quote.lineSubtotal}` : ""}
                            {i.quote.material ? (
                              <>
                                {" · "}
                                <Val v={i.quote.material} />
                              </>
                            ) : null}
                            {i.quote.specification ? (
                              <>
                                {" · "}
                                <Val v={i.quote.specification} />
                              </>
                            ) : null}
                            {i.quote.logo ? (
                              <>
                                {" · "}
                                <Val v={i.quote.logo} />
                              </>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>{t.termsHeading}</h3>
                <dl className="facts small">
                  {(["currency", "total", "paymentTerms", "leadTime", "incoterm"] as const).map((k) => (
                    <div key={k}>
                      <dt>{t.terms[k]}</dt>
                      <dd>{s.terms[k] ? <Val v={s.terms[k]!} /> : "—"}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              {subjects.length > 0 ? (
                <section className="card" data-testid="classify" aria-labelledby="req-heading">
                  <h2 id="req-heading">{t.requirementsHeading}</h2>
                  <p className="hint">{t.requirementsNote}</p>
                  <div className="req-list">
                    {subjects.map((f) => {
                      const rows = classHistory.filter((c) => c.subject === f.subject);
                      const view = (c: (typeof rows)[number]) => ({ id: c.id, decision: c.decision, reason: c.reason, excerpt: c.excerpt, createdAt: c.createdAt });
                      const current = f.code === "REQUIREMENT_NOT_CLASSIFIED" ? null : (rows.at(-1) ?? null);
                      const earlier = current ? rows.slice(0, -1) : rows;
                      const savedAt = Object.fromEntries(rows.map((c) => [c.id, utc(c.createdAt)]));
                      return (
                        <RequirementCard
                          key={f.subject}
                          requestId={id}
                          seriesId={seriesId}
                          versionId={versionId}
                          subject={f.subject}
                          label={f.args.subjectKind === "ADDITIONAL" ? t.classify.subjectAdditional : t.classify.subjectNotes(f.args.item ?? "")}
                          text={f.args.text ?? ""}
                          current={current ? view(current) : null}
                          earlier={earlier.map(view)}
                          canWrite={canWriteRequest(me, id)}
                          approvalActive={approvedHere}
                          paid={!!paidAny}
                          savedAt={savedAt}
                          runId={runId!}
                          baseRunId={baseRunId}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {infos.length > 0 ? (
                <section className="card" data-testid="info-list">
                  <h2>{t.infoHeading}</h2>
                  <ul className="small">
                    {infos.map((f) => (
                      <li key={f.key} data-code={f.code}>
                        {findingText(f)}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="card" data-testid="approval-basis" aria-labelledby="basis-heading">
                <h2 id="basis-heading">{t.technicalHeading}</h2>
                <p className="hint">{t.technicalNote}</p>
                <dl className="facts small">
                  <dt>{t.basis.request}</dt>
                  <dd>
                    {s.request.ref} · {t.basis.revision(s.request.revision, s.request.quoteSnapshotRevision)}
                  </dd>
                  <dt>{t.basis.quote}</dt>
                  <dd>
                    {series.name} ({shortSeriesId(series.id)}) · {t.basis.version(s.quote.versionNumber, s.quote.latestVersionNumber, CONTENT_KIND_LABELS[s.quote.contentKind as keyof typeof CONTENT_KIND_LABELS] ?? s.quote.contentKind)}
                    {s.quote.base ? ` · ${t.basis.base(s.quote.base.versionNumber)}` : ""}
                  </dd>
                  <dt>{t.basis.hash}</dt>
                  <dd>
                    <code>{s.quote.rawTextSha256.slice(0, 16)}…</code>
                  </dd>
                  <dt>{t.basis.run}</dt>
                  <dd>
                    {s.runs.run.mode} · {s.runs.run.provider} / {s.runs.run.model} · {s.runs.run.status} · <code>{s.runs.run.id.slice(0, 11)}…</code>
                    {s.runs.base ? ` · base ${s.runs.base.mode} ${s.runs.base.id.slice(0, 11)}…` : ""}
                  </dd>
                  <dt>{t.basis.rules}</dt>
                  <dd className="small">
                    {s.rules.approval} · {s.rules.comparator} · {s.rules.checkRules}
                  </dd>
                  <dt>{t.basis.payee}</dt>
                  <dd>{t.basis.payeeValue}</dd>
                  <dt>{t.basis.digest}</dt>
                  <dd>
                    <code data-testid="preview-digest">{e.digest.slice(0, 16)}…</code>
                  </dd>
                </dl>
                <p className="small muted">{t.intro}</p>
              </section>
            </>
          );
        })()
      )}

      {!pre || pre.status !== "OK" ? renderHistory() : null}
      <p className="hint">{t.footer}</p>
    </main>
  );

  // The approvals of this request with the payment of the Active one. Shown right after the decision (7 Nov), so
  // "Go to payment" lands next to it; content and controls unchanged.
  function renderHistory() {
    return (
      <section className="card" id="approval-history" data-testid="approval-history" aria-labelledby="history-heading">
        <h2 id="history-heading">{t.sectionsHeading.history}</h2>
        <p className="small muted">{t.historyHeading}</p>
        {history.length === 0 ? <p className="small muted">{t.historyNone}</p> : null}
        <ul className="plain">
          {history.map((h) => {
            const readiness = h.validity.state === "ACTIVE" ? service.paymentReadiness(me, id, h.approval.id) : null;
            const amount = h.approval.snapshot.money.thisPayment?.display ?? `${h.approval.currency} ${(h.approval.amountMinor / 100).toFixed(2)}`;
            return (
              <li key={h.approval.id} className="card" data-approval={h.approval.id} data-state={h.validity.state}>
                <p>
                  <strong>{t.state[h.validity.state]}</strong> · {t.historyLine(utc(h.approval.createdAt), h.approval.snapshot.quote.versionNumber, amount)}
                </p>
                <p className="small">
                  {t.actor}: {h.actorLabel}
                </p>
                {h.validity.reasons.length > 0 ? (
                  <p className="small" data-testid="validity-reasons">
                    {t.reasonsLabel} {h.validity.reasons.map((r) => t.reasons[r.split(":")[0]] ?? r).join("; ")}
                    {h.validity.since ? ` (${utc(h.validity.since)})` : ""}
                  </p>
                ) : null}
                {h.events
                  .filter((ev) => ev.kind === "REVOKED" && ev.note)
                  .map((ev) => (
                    <p key={ev.id} className="small muted">
                      “{ev.note}”
                    </p>
                  ))}
                {h.validity.state === "ACTIVE" || h.payments.length > 0 ? (
                  <PaymentSection
                    requestId={id}
                    approvalId={h.approval.id}
                    mode={payMode.mode}
                    refusedReason={payMode.mode === "REFUSED" ? payMode.reason : null}
                    clientId={clientId}
                    amount={amount}
                    quote={`${series!.name} (${shortSeriesId(series!.id)}) · v${h.approval.snapshot.quote.versionNumber} · ${h.approval.versionId.slice(0, 11)}… · text ${h.approval.snapshot.quote.rawTextSha256.slice(0, 12)}…`}
                    basis={t.pay.facts.basisValue(`${h.approval.id.slice(0, 11)}…`, `${h.approval.previewDigest.slice(0, 12)}…`, utc(h.approval.createdAt), h.approval.requestRevision)}
                    blockers={readiness?.blockers ?? (h.validity.state !== "ACTIVE" ? [`APPROVAL_${h.validity.state}`] : [])}
                    payments={h.payments.map((p) => ({
                      recordId: p.recordId,
                      status: p.status,
                      amount: money(p.amountMinor, p.currency),
                      paypalOrderId: p.paypalOrderId,
                      paypalOrderStatus: p.paypalOrderStatus,
                      paypalCaptureId: p.paypalCaptureId,
                      paypalCaptureStatus: p.paypalCaptureStatus,
                      lastError: p.lastError,
                      sku: p.sku,
                    }))}
                    active={h.validity.state === "ACTIVE"}
                    viewerCanPay={canPayRequest(me, id)}
                  />
                ) : (
                  <p className="small muted">
                    <strong>{t.paymentHeading}:</strong> {t.pay.notAllowed}
                    {`APPROVAL_${h.validity.state}`}
                  </p>
                )}
                {h.validity.state === "ACTIVE" && canRevokeApproval(me, id) ? <RevokeForm requestId={id} approvalId={h.approval.id} versionId={h.approval.versionId} /> : null}
                <details className="small">
                  <summary>{t.snapshotLink}</summary>
                  <pre className="pre small">{JSON.stringify(h.approval.snapshot, null, 2)}</pre>
                </details>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }
}

const MARK: Record<string, string> = { bad: "✕", warn: "!", ok: "✓", none: "○", wait: "…" };
function Cell({ name, tone, text, testid, state }: { name: string; tone: string; text: string; testid: string; state: string }) {
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

function Val({ v }: { v: SnapshotValue }) {
  const origin = v.origin ? (t.items.origin[v.origin] ?? v.origin) : t.items.origin.none;
  return (
    <span data-origin={v.origin ?? "NONE"} title={v.excerpt ?? undefined}>
      {v.value ?? v.modelValue ?? "—"} <span className="muted">({origin})</span>
    </span>
  );
}

function FeeList({ title, fees, id, hideEmpty }: { title: string; fees: FeeEntry[]; id: string; hideEmpty?: boolean }) {
  if (hideEmpty && fees.length === 0) return null;
  const u = t.money.unknownValue;
  return (
    <div className="small" data-testid={id}>
      <strong>{title}:</strong>{" "}
      {fees.length === 0 ? (
        t.money.none
      ) : (
        <ul>
          {fees.map((f) => (
            <li key={`${f.source}-${f.index}`}>{t.money.feeLine(f.description ?? f.kind ?? `#${f.index + 1}`, f.amount ?? u, f.payer ?? u, f.payee ?? u)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PaymentSection({
  requestId,
  approvalId,
  mode,
  refusedReason,
  clientId,
  amount,
  quote,
  basis,
  blockers,
  payments,
  active,
  viewerCanPay,
}: {
  requestId: string;
  approvalId: string;
  mode: "OFF" | "SANDBOX" | "MOCK" | "REFUSED";
  refusedReason: string | null;
  clientId: string | null;
  amount: string;
  quote: string;
  basis: string;
  blockers: string[];
  payments: PanelPayment[];
  active: boolean;
  /** Only the owning buyer pays; the approver sees the facts and the status, without payment controls. */
  viewerCanPay: boolean;
}) {
  const p = t.pay;
  const current = [...payments].reverse().find((x) => x.status !== "FAILED") ?? null;
  const enabled = mode === "SANDBOX" || mode === "MOCK";
  return (
    <div className="card" data-testid="payment-section" data-mode={mode}>
      <h3>{p.heading}</h3>
      {mode === "MOCK" ? <p className="card alert warn" data-testid="mock-banner">{p.mockBanner}</p> : null}
      {mode === "SANDBOX" ? <p className="card alert" data-testid="sandbox-banner">{p.sandboxBanner}</p> : null}
      <dl className="facts small" data-testid="payment-facts">
        <dt>{p.facts.environment}</dt>
        <dd data-testid="pay-env">{p.modeLabel[mode]}</dd>
        <dt>{p.facts.amount}</dt>
        <dd>
          <strong data-testid="pay-amount">{amount}</strong> <span className="muted">— {p.facts.amountNote}</span>
        </dd>
        <dt>{p.facts.quote}</dt>
        <dd>{quote}</dd>
        <dt>{p.facts.basis}</dt>
        <dd>{basis}</dd>
        <dt>{p.facts.payee}</dt>
        <dd data-testid="pay-payee">{p.facts.payeeValue}</dd>
        {payments.map((x) => {
          // 9 Nov: labels by the record's own kind (sku), not by the server's current mode.
          const kind = paymentKind(x.sku);
          const L = paymentLabels(kind);
          return (
          // display: contents keeps dt / dd in the two-column grid of .facts (as a grid item the wrapper widened column 1).
          <div key={x.recordId} data-testid="pay-record" data-status={x.status} data-kind={kind} style={{ display: "contents" }}>
            <dt>{p.facts.record}</dt>
            <dd>
              <code>{x.recordId.slice(0, 11)}…</code> · {x.status} · {x.amount} · <span className="muted">{x.sku}</span>
              <br />
              {L.order}: <code>{x.paypalOrderId ?? "—"}</code>
              {x.paypalOrderStatus ? ` (${x.paypalOrderStatus})` : ""} · {L.capture}: <code>{x.paypalCaptureId ?? "—"}</code>
              {x.paypalCaptureStatus ? ` (${x.paypalCaptureStatus})` : ""}
              {x.lastError ? (
                <>
                  <br />
                  {p.facts.lastError}: {x.lastError}
                </>
              ) : null}
            </dd>
          </div>
          );
        })}
      </dl>
      <p className="small muted" data-testid="local-note">{p.localNote}</p>
      {!viewerCanPay ? (
        <p className="small" data-testid="pay-buyer-only">
          {p.buyerOnly}
        </p>
      ) : !enabled ? (
        <p className="small" data-testid="pay-off">
          {mode === "REFUSED" && refusedReason ? p.refused(refusedReason) : p.off}
        </p>
      ) : (
        <>
          {blockers.length > 0 && !current ? (
            <p className="small" data-testid="readiness">
              {t.readinessBlocked(blockers.join(", "))}
            </p>
          ) : null}
          <PaymentPanel requestId={requestId} approvalId={approvalId} mode={mode} clientId={clientId} canStart={active && blockers.length === 0} active={active} current={current} />
        </>
      )}
    </div>
  );
}
