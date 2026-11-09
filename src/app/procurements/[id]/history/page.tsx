import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { shortProcurementId, type ProcurementRecord } from "@/lib/procurement";
import { en } from "@/i18n/en";
import { canReadRequest } from "@/server/access/policy";
import { getProcurementStore } from "@/server/procurement";
import { PROCUREMENT_ID } from "@/server/procurement/store";
import { requireSignedInPage } from "../../local-only";
import RecordView from "../../RecordView";

export const metadata: Metadata = {
  title: "Revision history — TradeProof",
  robots: { index: false, follow: false },
};

const t = en.history;

// Read-only: lists the stored revisions of one request and shows one of them. Choosing a revision is a
// link (?revision=N), so viewing never writes anything. Only the current revision links to editing.
export default async function RevisionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireSignedInPage("/procurements");
  const { id } = await params;
  if (!PROCUREMENT_ID.test(id) || !canReadRequest(me, id)) notFound();
  const store = getProcurementStore();
  const record = store.get(id);
  if (!record) notFound();
  const revisions = store.revisions(id);
  const asked = (await searchParams).revision;
  const wanted = typeof asked === "string" && /^[1-9][0-9]{0,8}$/.test(asked) ? Number(asked) : record.revision;
  const entry = store.revision(id, wanted);
  const earliest = revisions.at(-1) ?? null;

  return (
    <main className="page wide">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">{en.list.title}</Link> /{" "}
        <Link href={`/procurements/${record.id}`}>{shortProcurementId(record.id)}</Link> / {t.link}
      </p>
      <h1 className="title-break">{t.heading(record.title)}</h1>

      <section className="card" aria-label={t.listHeading}>
        <h2>{t.listHeading}</h2>
        {earliest ? (
          <p className="alert warn small" role="note" data-testid="history-start">
            {earliest.origin === "MIGRATION_BASELINE" ? t.startedAt(earliest.revision, en.common.utc(earliest.archivedAt)) : t.fullSince}
          </p>
        ) : null}
        <ul className="series-list">
          {revisions.map((r) => (
            <li key={r.revision}>
              <Link
                href={`/procurements/${record.id}/history?revision=${r.revision}`}
                className={`button series-button${r.revision === entry?.revision ? " selected" : ""}`}
                aria-current={r.revision === entry?.revision ? "true" : undefined}
                data-revision={r.revision}
              >
                <strong>
                  {t.revision(r.revision)} {r.current ? <span className="pill ok">{t.current}</span> : null}{" "}
                </strong>
                <span className="small muted">
                  {t.savedAt(en.common.utc(r.savedAt))}
                  {r.origin === "MIGRATION_BASELINE" ? ` · ${t.baselineNote(en.common.utc(r.archivedAt))}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="hint">
          {t.savedBy} {t.quoteSnapshotsNote}
        </p>
      </section>

      {entry ? (
        <>
          <div className={`card alert ${entry.current ? "ok-box" : "warn"}`} role="status" data-testid="viewing-revision">
            <h2>{t.viewing(entry.revision)}</h2>
            <p className="small">
              {entry.current ? t.viewingCurrent : t.viewingOld} {t.readOnlyFacts(entry.revision, t.savedAt(en.common.utc(entry.savedAt)))}
            </p>
            <div className="actions">
              <Link className="button" href={`/procurements/${record.id}`}>
                {entry.current ? t.editCurrent : t.backToCurrent}
              </Link>
            </div>
          </div>
          <RecordView record={entry.snapshot.record as ProcurementRecord} />
        </>
      ) : (
        <p className="card alert warn" role="status" data-testid="revision-not-stored">
          {t.notStored(wanted)}
        </p>
      )}
    </main>
  );
}
