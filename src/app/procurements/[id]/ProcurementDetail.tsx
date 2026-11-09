"use client";

// Read-only view of one procurement request, with an Edit mode that reuses the form.
// Everything the user typed is rendered as React text (never as HTML). Strings: src/i18n/en.ts.

import Link from "next/link";
import { useEffect, useState } from "react";
import { shortProcurementId, type ProcurementRecord } from "@/lib/procurement";
import { shortSeriesId, type QuoteSeries } from "@/lib/quote-versions";
import { en } from "@/i18n/en";
import { CopyId } from "../CopyId";
import ProcurementEditor from "../ProcurementEditor";
import RecordView from "../RecordView";
import { SourceTag } from "../SourceTag";

const t = en.detail;

export default function ProcurementDetail({
  initialRecord,
  justCreated,
  quotes,
  readOnly = false,
}: {
  initialRecord: ProcurementRecord;
  justCreated: boolean;
  quotes: QuoteSeries[];
  /** Approver view: no edit entry (the server refuses approvers' writes regardless). */
  readOnly?: boolean;
}) {
  const [record, setRecord] = useState(initialRecord);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(justCreated ? t.draftCreated(initialRecord.revision) : null);

  // Drop ?saved=created from the address bar so a refresh does not repeat the notice.
  useEffect(() => {
    if (justCreated) window.history.replaceState(null, "", window.location.pathname);
  }, [justCreated]);

  if (editing) {
    return (
      <>
        <h1 className="title-break">{t.editTitle(record.title)}</h1>
        <ProcurementEditor
          key={record.id}
          mode="edit"
          record={record}
          onSaved={(saved, changed) => {
            setRecord(saved);
            setEditing(false);
            setNotice(changed ? t.savedAs(saved.revision) : t.noChanges);
          }}
          onCancel={() => setEditing(false)}
        />
      </>
    );
  }

  return (
    <>
      {record.source === "DEMO_SAMPLE" ? (
        <p className="sandbox-banner" role="note">
          {t.demoBanner}
        </p>
      ) : null}
      <h1 className="title-break">{record.title}</h1>
      <p className="small muted">
        <strong className="ref">{shortProcurementId(record.id)}</strong> · <span className="pill">{record.status}</span> <SourceTag source={record.source} />{" "}
        {t.meta(record.revision, en.common.utc(record.createdAt), en.common.utc(record.updatedAt))}
      </p>
      <p className="small id-line">
        {en.ids.requestId}: <code className="full-id">{record.id}</code> <CopyId id={record.id} label={en.ids.copyRequestId} done={en.ids.requestIdCopied} />
      </p>
      {notice ? (
        <p className="card alert ok-box" role="status">
          {notice}
        </p>
      ) : null}
      <div className="actions">
        {readOnly ? null : (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            {t.edit}
          </button>
        )}
        <Link className="button" href={`/procurements/${record.id}/history`} data-testid="history-link">
          {en.history.link}
        </Link>
      </div>

      <section className="card" aria-label="Quotes">
        <div className="row-head">
          <h2>{t.quotesHeading(quotes.length)}</h2>
          <Link className="button" href={`/procurements/${record.id}/quotes`}>
            {quotes.length === 0 ? t.addQuote : t.openQuotes}
          </Link>
        </div>
        {quotes.length === 0 ? (
          <p className="muted small">{t.noQuotes}</p>
        ) : (
          <ul className="small">
            {quotes.map((s) => {
              const last = s.versions[s.versions.length - 1];
              return (
                <li key={s.id}>
                  <Link href={`/procurements/${record.id}/quotes?series=${s.id}`} className="pre">
                    {s.name}
                  </Link>{" "}
                  <span className="muted">
                    {shortSeriesId(s.id)} · {t.versions(s.versions.length)}
                    {last ? t.lastSaved(last.versionNumber, last.requestRevision) : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">{t.quotesHint}</p>
      </section>

      <RecordView record={record} />
    </>
  );
}
