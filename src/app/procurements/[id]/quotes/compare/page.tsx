import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Comparison, ComparisonRow, FeeView, QuoteValue } from "@/lib/comparison";
import { EXTRACTION_RUN_ID, FACT_CHECK_LABELS } from "@/lib/extraction";
import { shortItemRef, shortProcurementId } from "@/lib/procurement";
import { CONTENT_KIND_LABELS, QUOTE_SERIES_ID, QUOTE_VERSION_ID, shortSeriesId } from "@/lib/quote-versions";
import { en } from "@/i18n/en";
import { getClarificationService } from "@/server/clarification";
import type { DraftSummary } from "@/server/clarification/store";
import { getComparisonService } from "@/server/comparison";
import type { CompareChoices, RunOption } from "@/server/comparison/service";
import { canReadRequest } from "@/server/access/policy";
import { getProcurementStore } from "@/server/procurement";
import { PROCUREMENT_ID } from "@/server/procurement/store";
import { getQuoteStore } from "@/server/quotes";
import { requireSignedInPage } from "../../../local-only";
import CreateDraftButton from "./CreateDraftButton";

// Comparison page (26 Oct). Server-rendered from stored records on every request: reading it, refreshing it
// or choosing another run never starts an extraction, a review or a model call (there is no POST here).

export const metadata: Metadata = {
  title: "Compare with request — TradeProof",
  robots: { index: false, follow: false },
};

const t = en.comparison;
const utc = en.common.utc;

type Search = Record<string, string | string[] | undefined>;

function href(requestId: string, seriesId: string, versionId: string, runId: string | null, baseRunId: string | null): string {
  const q = new URLSearchParams({ series: seriesId, version: versionId });
  if (runId) q.set("run", runId);
  if (baseRunId) q.set("baseRun", baseRunId);
  return `/procurements/${requestId}/quotes/compare?${q.toString()}`;
}

/** Newest run that can be compared, or null. The page then names it in the address, so a refresh keeps it. */
function newestUsable(runs: RunOption[]): string | null {
  return runs.find((r) => r.refusal === null)?.id ?? null;
}

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
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
  if (!record || !series) notFound();

  const service = getComparisonService();
  const outcome = service.compare(me, id, seriesId, versionId, runId, runId ? baseRunId : null);
  if (outcome.status === "NOT_FOUND") notFound();
  // No run named: name the newest usable one (and, for a supplement, the base version's) in the address.
  if (outcome.status === "CHOOSE") {
    const chosen = newestUsable(outcome.choices.runs);
    if (chosen) redirect(href(id, seriesId, versionId, chosen, outcome.choices.base ? newestUsable(outcome.choices.base.runs) : null));
  }
  if (outcome.status === "OK" && outcome.choices.base && baseRunId === null && runId !== null) {
    const base = newestUsable(outcome.choices.base.runs);
    if (base) redirect(href(id, seriesId, versionId, runId, base));
  }

  const versionHref = `/procurements/${id}/quotes?series=${seriesId}&version=${versionId}`;
  const choices = outcome.choices;
  // Read-only list of drafts already generated for this version (creating one needs the button below).
  const drafts = outcome.status === "OK" ? (getClarificationService().list(me, id, seriesId, versionId) ?? []) : [];

  return (
    <main className="page wide compare-page">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">Procurement requests</Link> / <Link href={`/procurements/${id}`}>{shortProcurementId(id)}</Link> /{" "}
        <Link href={versionHref}>Quotes</Link> / {t.crumb}
      </p>
      <h1 className="title-break">
        {t.title} {t.titleZh} · {record.title}
      </h1>
      <p className="small muted">{t.intro}</p>

      {outcome.status === "OK" ? (
        <ComparisonView c={outcome.comparison} choices={choices} seriesName={series.name} seriesRef={shortSeriesId(series.id)} seriesCount={series.versions.length} rawText={outcome.rawText} baseRawText={outcome.baseRawText} hrefFor={(r, b) => href(id, seriesId, versionId, r, b)} versionHref={versionHref} drafts={drafts} draftHref={(d) => `/procurements/${id}/quotes/drafts/${d}`} ids={{ requestId: id, seriesId, versionId }} />
      ) : (
        <section className="card alert warn" data-testid="compare-refused">
          <h2>{outcome.status === "REFUSED" ? t.refusedTitle : t.noRunsTitle}</h2>
          <p>{outcome.status === "REFUSED" ? t.refusals[outcome.code] : t.noRuns}</p>
          <RunList runs={choices.runs} chosen={runId} hrefFor={(r) => href(id, seriesId, versionId, r, null)} heading={t.basis.otherRuns} />
          <p>
            <Link href={versionHref}>{t.backToVersion}</Link>
          </p>
        </section>
      )}
      <p className="hint">{t.footer}</p>
    </main>
  );
}

function RunList({ runs, chosen, hrefFor, heading }: { runs: RunOption[]; chosen: string | null; hrefFor: (runId: string) => string; heading: string }) {
  if (runs.length === 0) return null;
  return (
    <details className="small" open={runs.some((r) => r.id === chosen && r.refusal !== null)}>
      <summary>
        {heading} ({runs.length})
      </summary>
      <ul className="run-list">
        {runs.map((r) => (
          <li key={r.id} data-run-option={r.id} data-refusal={r.refusal ?? "NONE"}>
            {utc(r.startedAt)} · {r.mode} · {r.model} · {r.status} · <code>{r.id.slice(0, 11)}…</code> ·{" "}
            {r.id === chosen && r.refusal === null ? <strong>{t.basis.chosen}</strong> : r.refusal === null ? <Link href={hrefFor(r.id)}>{t.basis.choose}</Link> : <span className="muted">{t.refusals[r.refusal]}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ComparisonView({
  c,
  choices,
  seriesName,
  seriesRef,
  seriesCount,
  rawText,
  baseRawText,
  hrefFor,
  versionHref,
  drafts,
  draftHref,
  ids,
}: {
  c: Comparison;
  choices: CompareChoices;
  seriesName: string;
  seriesRef: string;
  seriesCount: number;
  rawText: string;
  baseRawText: string | null;
  hrefFor: (runId: string, baseRunId: string | null) => string;
  versionHref: string;
  drafts: DraftSummary[];
  draftHref: (draftId: string) => string;
  ids: { requestId: string; seriesId: string; versionId: string };
}) {
  const b = c.binding;
  const lines = new Map(c.requestLines.map((l) => [l.id, l] as const));
  const notAgreed = c.rows.filter((r) => r.note.code === "NOT_AGREED").length;
  const textFor = (v: QuoteValue) => (v.source === "BASE_VERSION" ? baseRawText : rawText);
  const lineName = (rid: string | null) => (rid ? `${lines.get(rid)?.name ?? rid} (${shortItemRef(rid)})` : null);
  const s = c.summary;
  const reviewed = s.confirmed + s.corrected + s.rejected;

  return (
    <>
      <section className="card" aria-label={t.basisHeading} data-testid="compare-basis">
        <h2>{t.basisHeading}</h2>
        <dl className="facts">
          <dt>{t.basis.request}</dt>
          <dd data-testid="basis-request">
            {t.basis.requestValue(shortProcurementId(b.requestId), b.snapshotRevision)}
            {b.requestUpdated && b.currentRequestRevision !== null ? (
              <span className="alert warn small block" role="note" data-testid="request-updated">
                {t.basis.requestUpdated(b.currentRequestRevision, b.snapshotRevision)}
              </span>
            ) : (
              <span className="muted small"> · {t.basis.requestCurrent}</span>
            )}
          </dd>
          <dt>{t.basis.quote}</dt>
          <dd data-testid="basis-version" data-version-id={b.version.id}>
            <span className="pre">{t.basis.quoteValue(seriesName, seriesRef, b.version.versionNumber, seriesCount)}</span>{" "}
            <span className="pill">{CONTENT_KIND_LABELS[b.version.contentKind]}</span>{" "}
            {b.version.latestVersionNumber > b.version.versionNumber ? <span className="small unsaved">{t.basis.newerVersion(b.version.latestVersionNumber)}</span> : <span className="small muted">{t.basis.latestNote}</span>}
            <span className="small muted block">{t.basis.textHash(b.version.rawTextSha256.slice(0, 16))}</span>
            <Link className="small" href={versionHref}>
              {t.backToVersion}
            </Link>
          </dd>
          <dt>{t.basis.run}</dt>
          <dd data-testid="basis-run" data-run-id={b.run.id}>
            {t.basis.runValue(utc(b.run.startedAt), b.run.mode === "MOCK" ? "MOCK" : en.extraction.livePill, `${b.run.provider} / ${b.run.model}`, en.extraction.status[b.run.status as keyof typeof en.extraction.status] ?? b.run.status)}
            {b.run.mode === "MOCK" ? (
              <span className="pill source-demo" data-testid="mock-run">
                {t.basis.mockNote}
              </span>
            ) : null}
            <span className="small muted block">
              {t.basis.rules(b.run.checkRules, b.run.promptVersion)} · {t.basis.runId(b.run.id)}
            </span>
            <RunList runs={choices.runs} chosen={b.run.id} hrefFor={(r) => hrefFor(r, b.base?.run?.id ?? null)} heading={t.basis.otherRuns} />
          </dd>
          {b.base ? (
            <>
              <dt>{t.basis.supplementBase}</dt>
              <dd data-testid="basis-base" data-base-version-id={b.base.versionId}>
                {t.basis.baseValue(b.base.versionNumber)}
                <span className="small block">
                  {t.basis.baseRun}:{" "}
                  {b.base.run ? (
                    <span data-testid="base-run" data-run-id={b.base.run.id}>
                      {utc(b.base.run.startedAt)} · {b.base.run.mode} · {b.base.run.model} · {b.base.run.checkRules} · <code>{b.base.run.id.slice(0, 11)}…</code>
                    </span>
                  ) : (
                    <span className="unsaved" data-testid="base-run-none">
                      {t.basis.baseRunNone}
                    </span>
                  )}
                </span>
                {choices.base ? <RunList runs={choices.base.runs} chosen={b.base.run?.id ?? null} hrefFor={(r) => hrefFor(b.run.id, r)} heading={t.basis.baseRuns} /> : null}
              </dd>
            </>
          ) : null}
        </dl>
        <p className="hint">{t.basis.comparator(b.comparatorVersion, b.asOf)}</p>
      </section>

      <section className="card" aria-label={t.summaryHeading} data-testid="compare-summary">
        <h2>{t.summaryHeading}</h2>
        <p className="compare-counts">
          <span className="pill s-FAILED" data-testid="count-differences">
            {t.summary.differences(s.differences)}
          </span>{" "}
          <span className="pill warn" data-testid="count-open">
            {t.summary.open(s.open)}
          </span>{" "}
          <span className="pill" data-testid="count-matches">
            {t.summary.matches(s.matches)}
          </span>
        </p>
        <p className="small" data-testid="review-status">
          {t.summary.review(reviewed, s.valuesUsed, s.confirmed, s.corrected, s.rejected)} {s.pending > 0 ? <span className="unsaved">{t.summary.pending(s.pending)}</span> : null}
        </p>
        <p className="small">{t.summary.pairs(s.pairsConfirmed, s.pairsProposed, s.pairsOpen)}</p>
        <ul className="small">
          {c.cost.openCount > 0 ? <li data-testid="notice-unknown-fees">{t.notices.unknownFees(c.cost.openCount)}</li> : null}
          {c.cost.duplicateCount > 0 ? <li data-testid="notice-duplicates">{t.notices.duplicates(c.cost.duplicateCount)}</li> : null}
          {notAgreed > 0 ? <li data-testid="notice-not-agreed">{t.notices.notAgreed(notAgreed)}</li> : null}
          {c.unresolvedInheritance.length > 0 ? <li data-testid="notice-unresolved">{t.notices.unresolved(c.unresolvedInheritance.length)}</li> : null}
        </ul>
        <p className="hint">{t.summary.consistentNote}</p>
        <p className="hint">{t.summary.useNote}</p>
      </section>

      <section className="card" aria-label={t.detailHeading} data-testid="compare-details">
        <h2>{t.detailHeading}</h2>
        <div className="table-scroll">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">{t.cols.item}</th>
                <th scope="col">{t.cols.request}</th>
                <th scope="col">{t.cols.quote}</th>
                <th scope="col">{t.cols.result}</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row) => (
                <Row key={row.key} row={row} lineName={lineName} textFor={textFor} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-label={t.pairingHeading} data-testid="compare-pairing">
        <h2>{t.pairingHeading}</h2>
        <div className="table-scroll">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">{t.pairingCols.quote}</th>
                <th scope="col">{t.pairingCols.line}</th>
                <th scope="col">{t.pairingCols.status}</th>
                <th scope="col">{t.pairingCols.price}</th>
                <th scope="col">{t.pairingCols.subtotal}</th>
              </tr>
            </thead>
            <tbody>
              {c.pairings.map((p) => (
                <tr key={`${p.source}-${p.quoteItemIndex}`} data-pairing={p.status} data-quote-index={p.quoteItemIndex} data-request-item={p.requestItemId ?? ""}>
                  <td className="pre">
                    #{p.quoteItemIndex + 1} {p.quoteItemName ?? t.value.unknown}
                    {p.source === "BASE_VERSION" ? <span className="small muted block">{t.value.fromBase(c.binding.base?.versionNumber ?? 0)}</span> : null}
                  </td>
                  <td className="pre">{lineName(p.requestItemId) ?? "—"}</td>
                  <td>
                    <span className={p.status === "CONFIRMED" ? "pill" : "pill warn"}>{t.pairing[p.status]}</span>
                    {p.invalidChoice ? <span className="small error block">{t.invalidChoice(p.invalidChoice)}</span> : null}
                  </td>
                  <td>{p.unitPrice.used ?? <span className="muted">{t.value.unknown}</span>}</td>
                  <td>{p.lineSubtotal ?? <span className="muted">{t.value.unknown}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {c.binding.version.contentKind === "SUPPLEMENT" ? (
        <section className="card" aria-label={t.inheritanceHeading} data-testid="compare-inheritance">
          <h2>{t.inheritanceHeading}</h2>
          <dl className="facts">
            {c.inheritance.map((e) => (
              <InheritanceRow key={e.field} label={t.fields[e.field]} status={e.status} views={e.views} textFor={textFor} />
            ))}
          </dl>
          {c.unresolvedInheritance.filter((u) => u.startsWith("item:")).length > 0 ? (
            <ul className="small">
              {c.unresolvedInheritance
                .filter((u) => u.startsWith("item:"))
                .map((u) => (
                  <li key={u} className="unsaved">
                    {t.unresolvedItem(lines.get(u.slice(5))?.name ?? u.slice(5))}
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="card" aria-label={t.feesHeading} data-testid="compare-fees">
        <h2>{t.feesHeading}</h2>
        {c.fees.length === 0 ? (
          <p className="muted small">{t.noFees}</p>
        ) : (
          <div className="table-scroll">
            <table className="compare-table">
              <thead>
                <tr>
                  <th scope="col">{t.feeCols.fee}</th>
                  <th scope="col">{t.feeCols.amount}</th>
                  <th scope="col">{t.feeCols.how}</th>
                  <th scope="col">{t.feeCols.status}</th>
                </tr>
              </thead>
              <tbody>
                {c.fees.map((f) => (
                  <FeeRow key={`${f.source}-${f.index}`} f={f} textFor={textFor} baseVersion={c.binding.base?.versionNumber ?? null} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label={t.costHeading} data-testid="compare-cost">
        <h2>{t.costHeading}</h2>
        {!c.cost.computed ? (
          <p className="small">{t.cost.notComputed}</p>
        ) : c.cost.lines.length === 0 ? (
          <p className="small muted">{t.cost.none}</p>
        ) : (
          <ul className="small">
            {c.cost.lines.map((l) => (
              <li key={l.currency} data-cost-currency={l.currency}>
                <strong>{l.currency}</strong>
                {l.statedGoodsTotal !== null ? ` · ${t.cost.stated(l.statedGoodsTotal)}` : ""}
                {l.sumOfItemLines !== null ? ` · ${t.cost.sum(l.sumOfItemLines)}` : ""}
                {l.knownExtraCount > 0 ? ` · ${t.cost.extras(l.knownExtras, l.knownExtraCount)}` : ""}
              </li>
            ))}
          </ul>
        )}
        <p className="small unsaved" data-testid="cost-incomplete">
          {t.cost.incomplete(c.cost.openCount, c.cost.duplicateCount)}
        </p>
        <p className="hint">{t.cost.notPayment}</p>
      </section>

      <section className="card anchor-target" id="clarification" aria-label={t.questionsHeading} data-testid="compare-questions">
        <h2>{t.questionsHeading}</h2>
        <p className="hint">{t.questionsNote}</p>
        {c.questions.length === 0 ? (
          <p className="small muted">{t.noQuestions}</p>
        ) : (
          <ol className="small">
            {c.questions.map((q) => (
              <li key={q.key} className="pre" data-question={q.code}>
                {t.questions[q.code]({ ...q.args, field: t.questionFields[q.args.field] ?? q.args.field ?? "" })}
              </li>
            ))}
          </ol>
        )}
        <div className="draft-entry" data-testid="draft-entry">
          <h3>{en.clarification.createHeading}</h3>
          <p className="hint">{en.clarification.createNote}</p>
          <CreateDraftButton requestId={ids.requestId} seriesId={ids.seriesId} versionId={ids.versionId} runId={b.run.id} baseRunId={b.base?.run?.id ?? null} />
          {drafts.length > 0 ? (
            <details className="small" open data-testid="draft-list">
              <summary>{en.clarification.existingDrafts(drafts.length)}</summary>
              <ul>
                {drafts.map((d) => (
                  <li key={d.id} data-draft={d.id}>
                    {en.clarification.draftLine(utc(d.createdAt), d.revision, d.selectedCount, d.questionCount)} · {d.extractionId === b.run.id ? en.clarification.thisRun : en.clarification.otherRun}
                    {drafts.some((x) => x.supersedesId === d.id) ? ` · ${en.clarification.replaced}` : ""} · <Link href={draftHref(d.id)}>{en.clarification.open}</Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>
      <section className="card" data-testid="approval-entry">
        <h2>{en.approval.title}</h2>
        <p className="hint">{en.approval.entryNote}</p>
        <Link href={`/procurements/${ids.requestId}/quotes/approval?series=${ids.seriesId}&version=${ids.versionId}&run=${b.run.id}${b.base?.run ? `&baseRun=${b.base.run.id}` : ""}`} data-testid="approval-link">
          {en.approval.entry}
        </Link>
      </section>
    </>
  );
}

function Row({ row, lineName, textFor }: { row: ComparisonRow; lineName: (id: string | null) => string | null; textFor: (v: QuoteValue) => string | null }) {
  const item = row.requestItemId ? lineName(row.requestItemId) : row.field === "pairing" ? null : t.terms;
  return (
    <tr data-outcome={row.outcome} data-field={row.field} data-note={row.note.code} data-request-item={row.requestItemId ?? ""} data-quote-index={row.quoteItemIndex ?? ""}>
      <td>
        <strong>{t.fields[row.field]}</strong>
        {item ? <span className="small muted block pre">{item}</span> : null}
        {row.provisionalPairing ? <span className="small unsaved block">{t.provisional}</span> : null}
      </td>
      <td className="pre">{row.requestText ?? <span className="muted">—</span>}</td>
      <td>
        {row.quote.length === 0 ? <span className="muted">—</span> : null}
        {row.quote.map((v) => (
          <ValueCell key={`${v.runId}:${v.path}`} v={v} text={textFor(v)} />
        ))}
      </td>
      <td>
        <span className={row.outcome === "DIFFERENCE" ? "pill s-FAILED" : row.outcome === "OPEN" ? "pill warn" : "pill"}>{t.outcomes[row.outcome]}</span>
        <span className="small block">{t.notes[row.note.code](row.note.args)}</span>
      </td>
    </tr>
  );
}

function ValueCell({ v, text }: { v: QuoteValue; text: string | null }) {
  const lineText = v.evidence && text !== null ? (text.split("\n")[v.evidence.line - 1] ?? null) : null;
  const state =
    v.review === "CORRECTED"
      ? t.value.corrected(v.correctionText ?? "")
      : v.review === "REJECTED"
        ? t.value.rejected
        : v.review === "CONFIRMED"
          ? t.value.confirmed
          : v.used !== null
            ? t.value.model
            : t.value.pending;
  return (
    <div className="compare-value" data-path={v.path} data-review={v.review} data-used-from={v.usedFrom ?? "NONE"} data-source={v.source}>
      <span className={v.used === null ? "muted" : "pre"}>{v.used ?? t.value.unknown}</span>
      {v.source === "BASE_VERSION" ? <span className="small muted"> · {t.value.fromBase(v.versionNumber)}</span> : null}
      <span className={`small block${v.review === "PENDING" ? " muted" : ""}`}>
        {state}
        {v.reviewedAt ? ` · ${t.value.reviewedAt(utc(v.reviewedAt))}` : ""}
      </span>
      {v.review === "CORRECTED" || v.used === null ? (
        v.modelValue !== null ? <span className="small muted block pre">{t.value.modelSaid(v.modelValue)}</span> : null
      ) : null}
      <details className="small evidence">
        <summary>
          {v.evidence ? t.value.evidence(v.evidence.line, v.evidence.occurrences) : t.value.noEvidence} · <span className={`pill check-${v.check}`}>{FACT_CHECK_LABELS[v.check]}</span>
          {v.interpreted ? <span className="muted"> ({t.value.interpreted})</span> : null}
        </summary>
        {v.evidence ? (
          <>
            <q className="pre">{v.evidence.excerpt}</q>
            {lineText !== null ? (
              <span className="block muted">
                {t.value.lineContext} ({v.evidence.line}): <span className="pre">{lineText}</span>
              </span>
            ) : null}
          </>
        ) : null}
      </details>
    </div>
  );
}

function InheritanceRow({ label, status, views, textFor }: { label: string; status: string; views: QuoteValue[]; textFor: (v: QuoteValue) => string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-inheritance={status}>
        <span className={status === "UNRESOLVED" ? "pill warn" : "pill"}>{t.inheritance[status]}</span>
        {views.map((v) => (
          <ValueCell key={`${v.runId}:${v.path}`} v={v} text={textFor(v)} />
        ))}
      </dd>
    </>
  );
}

function FeeRow({ f, textFor, baseVersion }: { f: FeeView; textFor: (v: QuoteValue) => string | null; baseVersion: number | null }) {
  const show = (v: QuoteValue, labels?: Record<string, string>) => (v.used === null ? t.value.unknown : (labels?.[v.used] ?? v.used));
  return (
    <tr data-fee-status={f.status} data-fee-index={f.index} data-fee-source={f.source}>
      <td>
        <span className="pre">{f.description.used ?? f.description.modelValue ?? `#${f.index + 1}`}</span>
        <span className="small muted block">
          {show(f.kind, en.extraction.feeKinds as Record<string, string>)}
          {f.source === "BASE_VERSION" && baseVersion !== null ? ` · ${t.value.fromBase(baseVersion)}` : ""}
        </span>
      </td>
      <td>
        <ValueCell v={f.amount} text={textFor(f.amount)} />
      </td>
      <td className="small">
        {show(f.basis, en.extraction.basis as Record<string, string>)} · {show(f.included, en.extraction.included as Record<string, string>)} · {show(f.statedAs, en.extraction.statedAs as Record<string, string>)}
      </td>
      <td>
        <span className={f.status === "KNOWN_EXTRA" ? "pill" : "pill warn"}>{t.feeStatus[f.status]}</span>
        {f.reasons.length > 0 ? (
          <ul className="small">
            {f.reasons.map((r) => (
              <li key={r}>{t.feeReasons[r]}</li>
            ))}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}
