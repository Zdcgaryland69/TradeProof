"use client";

// Quotes for one procurement request: series list, version list, read-only version view (raw text with
// display-only line numbers + the request snapshot linked at save time), and the composer for a new
// quote or a new version. All text is rendered by React as text; nothing the user pasted is interpreted.

import Link from "next/link";
import { useEffect, useState } from "react";
import { shortItemRef, shortProcurementId, type ProcurementRecord } from "@/lib/procurement";
import { CONTENT_KIND_LABELS, shortSeriesId, snapshotBuyer, type QuoteSeries, type QuoteVersion } from "@/lib/quote-versions";
import { en } from "@/i18n/en";
import type { EntryRole } from "@/lib/approval-entry";
import { ItemRef } from "../../CopyId";
import ApprovalEntry from "./ApprovalEntry";
import CopilotPanel from "./CopilotPanel";
import ExtractionPanel from "./ExtractionPanel";
import type { QuoteDemoSample } from "@/server/quotes/demo";
import QuoteComposer, { type SavedQuote } from "./QuoteComposer";
import { RawText, SourcePill, utc } from "./QuoteParts";

type Props = {
  record: ProcurementRecord;
  initialSeries: QuoteSeries[];
  demos: QuoteDemoSample[];
  initialSeriesId: string | null;
  initialVersionId: string | null;
  /** Approver view: no quote saving, extraction runs or reviews (the server refuses them regardless). */
  readOnly?: boolean;
  /** Approval entry for the selected version: who the viewer is for this request, and (owner only) whether an approver is assigned. */
  approval: { role: EntryRole; approverAssigned: boolean | null; approverName: string | null; paymentMode: "OFF" | "SANDBOX" | "MOCK" | "REFUSED" };
};

type Composer = null | { mode: "new-series" } | { mode: "revision"; seriesId: string };

type Loaded = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; version: QuoteVersion };

type Fetched = { version: QuoteVersion } | { error: string };

function SnapshotView({ version, currentRevision }: { version: QuoteVersion; currentRevision: number }) {
  const t = en.snapshot;
  const snap = version.requestSnapshot.record;
  const buyer = snapshotBuyer(version.requestSnapshot);
  const outdated = currentRevision !== version.requestRevision;
  return (
    <section className="card snapshot" aria-label="Linked request snapshot">
      <h3>{t.heading(version.requestRevision)}</h3>
      {outdated ? (
        <p className="alert warn small" role="note" data-testid="request-updated-note">
          {t.updatedSince(currentRevision, version.requestRevision)}
        </p>
      ) : (
        <p className="small muted">{t.stillCurrent}</p>
      )}
      <p className="hint">{t.boundaryHint}</p>
      <dl className="facts">
        <dt>{t.title}</dt>
        <dd className="pre">{snap.title}</dd>
        <dt>{t.buyer}</dt>
        <dd data-testid="snapshot-buyer">
          {buyer.recorded ? (
            <>
              {buyer.buyerType === null ? en.buyer.notRecorded : en.buyer.types[buyer.buyerType]}
              {snap.buyerCompany ? <span className="pre"> · {snap.buyerCompany}</span> : null}
              {buyer.buyerPersonName ? <span className="pre"> · {buyer.buyerPersonName}</span> : null}
            </>
          ) : (
            <>
              <span className="muted">
                {en.buyer.sectionLabel}: {en.buyer.snapshotNotRecorded}
              </span>
              {snap.buyerCompany ? <span className="pre"> · {snap.buyerCompany}</span> : null}
            </>
          )}
        </dd>
        <dt>{t.budgetCap}</dt>
        <dd>{snap.budgetMax === null ? <span className="muted">{t.noCap}</span> : `${snap.budgetCurrency} ${snap.budgetMax}`}</dd>
        <dt>{t.requiredShipDate}</dt>
        <dd>{snap.requiredShipDate ?? <span className="muted">—</span>}</dd>
        <dt>{t.paymentTerms}</dt>
        <dd className="pre">{snap.paymentTerms ?? <span className="muted">—</span>}</dd>
      </dl>
      <ol className="items snapshot-items">
        {snap.items.map((item) => (
          <li key={item.id} className="item" data-item-id={item.id}>
            <strong className="pre">{item.name}</strong> <ItemRef id={item.id} refText={shortItemRef(item.id)} />
            <div className="small pre">
              {item.quantity === null ? t.quantityNotSpecified : `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`}
              {item.material ? ` · ${item.material}` : ""}
              {item.specification ? ` · ${item.specification}` : ""}
              {item.customization ? ` · ${item.customization}` : ""}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function QuoteWorkspace({ record, initialSeries, demos, initialSeriesId, initialVersionId, readOnly = false, approval }: Props) {
  const [seriesList, setSeriesList] = useState<QuoteSeries[]>(initialSeries);
  const startSeries = initialSeries.find((s) => s.id === initialSeriesId) ?? initialSeries[0] ?? null;
  const [seriesId, setSeriesId] = useState<string | null>(startSeries?.id ?? null);
  const [versionId, setVersionId] = useState<string | null>(
    startSeries ? (startSeries.versions.find((v) => v.id === initialVersionId) ?? startSeries.versions[startSeries.versions.length - 1])?.id ?? null : null,
  );
  // Full versions (text + snapshot) fetched on demand; the loading / error / ready view is derived from it.
  const [fetched, setFetched] = useState<Record<string, Fetched>>({});
  const [attempt, setAttempt] = useState(0);
  const [composer, setComposer] = useState<Composer>(initialSeries.length === 0 ? { mode: "new-series" } : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestRevision, setRequestRevision] = useState(record.revision);

  const series = seriesList.find((s) => s.id === seriesId) ?? null;

  // Keep the selection in the address bar so a reload (or a server restart) reopens the same version.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (seriesId) url.searchParams.set("series", seriesId);
    else url.searchParams.delete("series");
    if (versionId) url.searchParams.set("version", versionId);
    else url.searchParams.delete("version");
    window.history.replaceState(null, "", url);
  }, [seriesId, versionId]);

  useEffect(() => {
    if (!seriesId || !versionId || fetched[versionId]) return;
    let live = true;
    const vId = versionId;
    fetch(`/api/procurements/${record.id}/quotes/${seriesId}/versions/${vId}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as { version?: QuoteVersion; message?: string } | null;
        return res.ok && data?.version ? { version: data.version } : { error: data?.message ?? `HTTP ${res.status}` };
      })
      .catch(() => ({ error: "Could not reach the local server." }))
      .then((result) => {
        if (live) setFetched((prev) => ({ ...prev, [vId]: result }));
      });
    return () => {
      live = false;
    };
  }, [seriesId, versionId, fetched, attempt, record.id]);

  const entry = versionId ? fetched[versionId] : undefined;
  const loaded: Loaded = !versionId ? { kind: "idle" } : !entry ? { kind: "loading" } : "version" in entry ? { kind: "ready", version: entry.version } : { kind: "error", message: entry.error };

  function retry() {
    if (!versionId) return;
    setFetched((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== versionId)));
    setAttempt((n) => n + 1);
  }

  async function refreshList(): Promise<QuoteSeries[] | null> {
    try {
      const res = await fetch(`/api/procurements/${record.id}/quotes`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { series?: QuoteSeries[] } | null;
      if (res.ok && data?.series) {
        setSeriesList(data.series);
        return data.series;
      }
    } catch {
      // keep the list we have
    }
    return null;
  }

  function onSaved(saved: SavedQuote) {
    setSeriesList((prev) => {
      const others = prev.filter((s) => s.id !== saved.series.id);
      return [...others, saved.series].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
    setFetched((prev) => ({ ...prev, [saved.version.id]: { version: saved.version } }));
    setSeriesId(saved.series.id);
    setVersionId(saved.version.id);
    setComposer(null);
    setNotice(saved.message);
    setRequestRevision(Math.max(requestRevision, saved.version.requestRevision));
  }

  const latest = series ? series.versions[series.versions.length - 1] : null;

  return (
    <div className="quotes">
      {notice ? (
        <p className="card alert ok-box" role="status">
          {notice}
        </p>
      ) : null}

      {/* 5 Nov: the decision summary for the selected version comes first (it names the version itself): check result,
          the first reasons with their source lines, and the viewer's next step — readable without scrolling. */}
      {series && loaded.kind === "ready" && loaded.version.seriesId === series.id ? (
        <ApprovalEntry
          key={`approval-${loaded.version.id}`}
          requestId={record.id}
          seriesId={series.id}
          seriesName={series.name}
          versionId={loaded.version.id}
          role={approval.role}
          approverAssigned={approval.approverAssigned}
          approverName={approval.approverName}
          paymentMode={approval.paymentMode}
          rawText={loaded.version.rawText}
          latestVersionId={latest?.id ?? loaded.version.id}
          onOpenVersion={(sId, vId) => {
            setSeriesId(sId);
            setVersionId(vId);
            window.scrollTo({ top: 0 });
          }}
        />
      ) : null}

      <section className="card">
        <div className="row-head">
          <h2>Quote series ({seriesList.length})</h2>
          {readOnly ? null : (
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setComposer({ mode: "new-series" });
              }}
              disabled={composer !== null}
            >
              + New quote
            </button>
          )}
        </div>
        {seriesList.length === 0 ? (
          <p className="muted">No quotes saved for this request yet. Paste the supplier&apos;s quote text below to save version 1.</p>
        ) : (
          <ul className="series-list">
            {seriesList.map((s) => {
              const last = s.versions[s.versions.length - 1];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`series-button${s.id === seriesId ? " selected" : ""}`}
                    aria-pressed={s.id === seriesId}
                    onClick={() => {
                      setSeriesId(s.id);
                      setVersionId(s.versions[s.versions.length - 1]?.id ?? null);
                    }}
                  >
                    <strong className="pre">{s.name}</strong>
                    <span className="small muted">
                      {shortSeriesId(s.id)} · supplier: {s.supplierDisplayName ?? "not named"} · {s.versions.length} version{s.versions.length === 1 ? "" : "s"}
                      {last ? ` · last saved v${last.versionNumber} ${utc(last.savedAt)}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {composer && !readOnly ? (
        <QuoteComposer
          key={composer.mode === "revision" ? `rev-${composer.seriesId}` : "new"}
          requestId={record.id}
          requestRevision={requestRevision}
          defaultSupplier={record.supplierName}
          series={composer.mode === "revision" ? (seriesList.find((s) => s.id === composer.seriesId) ?? null) : null}
          demos={demos}
          onSaved={onSaved}
          onCancel={() => setComposer(null)}
          onRequestRevision={setRequestRevision}
          onRefreshSeries={refreshList}
        />
      ) : null}

      {series ? (
        <section className="card" aria-label="Quote versions">
          <div className="row-head">
            <h2 className="pre">
              {series.name} <span className="muted small">{shortSeriesId(series.id)}</span>
            </h2>
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  setComposer({ mode: "revision", seriesId: series.id });
                }}
                disabled={composer !== null}
              >
                + Add revision
              </button>
            )}
          </div>
          <p className="small muted">
            Supplier (as entered, not verified; never used to choose a PayPal payee): {series.supplierDisplayName ?? "not named"} · created {utc(series.createdAt)}
          </p>
          <div className="version-tabs" role="tablist" aria-label="Versions">
            {series.versions.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.id === versionId}
                className={`version-tab${v.id === versionId ? " selected" : ""}`}
                onClick={() => setVersionId(v.id)}
                data-version={v.versionNumber}
              >
                v{v.versionNumber}
                {v.contentKind === "SUPPLEMENT" ? ` · supplement to v${v.supplementsVersionNumber}` : ""}
                {v.id === latest?.id ? " · latest saved" : ""}
              </button>
            ))}
          </div>

          {loaded.kind === "loading" ? <p className="muted">Loading version…</p> : null}
          {loaded.kind === "error" ? (
            <p className="card alert error-box" role="alert">
              Could not load this version: {loaded.message}{" "}
              <button type="button" onClick={retry}>
                Retry
              </button>
            </p>
          ) : null}
          {loaded.kind === "ready" && loaded.version.seriesId === series.id ? (
            <article className="version-view" data-version-id={loaded.version.id}>
              <h3>
                {shortProcurementId(record.id)} › <span className="pre">{series.name}</span> › version {loaded.version.versionNumber} of {series.versions.length}
              </h3>
              <p className="small">
                <span className="pill">{CONTENT_KIND_LABELS[loaded.version.contentKind]}</span> <SourcePill source={loaded.version.source} />{" "}
                {loaded.version.id === latest?.id ? (
                  <span className="pill" title="Last saved version. It has not been accepted or approved.">
                    Latest saved — not accepted
                  </span>
                ) : null}{" "}
                saved {utc(loaded.version.savedAt)}
              </p>
              {loaded.version.contentKind === "SUPPLEMENT" ? (
                <p className="alert warn small" role="note">
                  Supplement to version {loaded.version.supplementsVersionNumber}. It does not replace that version, and terms it does not mention are not
                  treated as cancelled. Terms are not merged automatically.
                </p>
              ) : null}
              <dl className="facts">
                <dt>Supplier&apos;s quote date</dt>
                <dd>{loaded.version.supplierQuoteDate ?? <span className="muted">not entered</span>}</dd>
                <dt>Source note</dt>
                <dd className="pre">{loaded.version.sourceNote ?? <span className="muted">—</span>}</dd>
                <dt>Revision note</dt>
                <dd>
                  {loaded.version.revisionNote ? (
                    <>
                      <span className="pre">{loaded.version.revisionNote}</span> <span className="muted small">(written by the user; not verified)</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
                <dt>Text</dt>
                <dd className="small">
                  {loaded.version.rawTextLength} characters · SHA-256{" "}
                  <code title={loaded.version.rawTextSha256}>{loaded.version.rawTextSha256.slice(0, 16)}…</code>{" "}
                  <span className="muted">(detects later changes to the stored text; does not prove who wrote it)</span>
                </dd>
              </dl>
              <RawText text={loaded.version.rawText} label={`Quote text, version ${loaded.version.versionNumber}`} />
              <SnapshotView version={loaded.version} currentRevision={requestRevision} />
              <p className="small" data-testid="compare-entry">
                <Link href={`/procurements/${record.id}/quotes/compare?series=${series.id}&version=${loaded.version.id}`} prefetch={false}>
                  {en.comparison.openLink}
                </Link>{" "}
                <span className="muted">{en.comparison.openLinkHint}</span>
              </p>
              <CopilotPanel key={`copilot-${loaded.version.id}`} requestId={record.id} seriesId={series.id} versionId={loaded.version.id} />
              {readOnly ? (
                <p className="small muted" data-testid="extraction-readonly">
                  Extraction runs and reviews are the buyer&apos;s; open Compare or Approval to see the reviewed values.
                </p>
              ) : (
                <ExtractionPanel key={loaded.version.id} requestId={record.id} seriesId={series.id} version={loaded.version} />
              )}
            </article>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
