import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BILINGUAL_CHECK_RULES } from "@/lib/clarification";
import { shortProcurementId } from "@/lib/procurement";
import { en } from "@/i18n/en";
import { canReadRequest } from "@/server/access/policy";
import { getClarificationService } from "@/server/clarification";
import { CLARIFICATION_DRAFT_ID } from "@/server/clarification/store";
import { getProcurementStore } from "@/server/procurement";
import { PROCUREMENT_ID } from "@/server/procurement/store";
import { getReplyService } from "@/server/replies";
import { requireSignedInPage } from "../../../../local-only";
import DraftEditor, { RegenerateButton } from "./DraftEditor";
import ReplyTracker from "./ReplyTracker";

// Clarification draft page (27 Oct). Server-rendered from stored rows: opening or refreshing it reads the
// draft, recomputes the comparison only to report whether its basis changed, and writes nothing. A new draft
// is generated only by an explicit button press.

export const metadata: Metadata = {
  title: "Clarification draft — TradeProof",
  robots: { index: false, follow: false },
};

const t = en.clarification;
const utc = en.common.utc;
const changeText = (code: string, args: Record<string, string>) => {
  const v = t.changed[code];
  return typeof v === "function" ? v(args) : code;
};

export default async function DraftPage({ params }: { params: Promise<{ id: string; draftId: string }> }) {
  const me = await requireSignedInPage("/procurements");
  const { id, draftId } = await params;
  if (!PROCUREMENT_ID.test(id) || !CLARIFICATION_DRAFT_ID.test(draftId)) notFound();
  if (!canReadRequest(me, id)) notFound();
  const record = getProcurementStore().get(id);
  if (!record) notFound();
  const view = getClarificationService().open(me, id, draftId);
  if (!view) notFound();
  const { draft, basis } = view;
  const replies = getReplyService().view(me, id, draftId);
  if (!replies) notFound();
  const s = draft.source;
  const compareHref = `/procurements/${id}/quotes/compare?series=${draft.seriesId}&version=${draft.versionId}&run=${draft.extractionId}${draft.baseExtractionId ? `&baseRun=${draft.baseExtractionId}` : ""}`;
  const createUrl = `/api/procurements/${id}/quotes/${draft.seriesId}/versions/${draft.versionId}/clarification-drafts`;
  const regenerateRun = basis.changes.includes("BASIS_NOT_USABLE") ? null : (basis.newerRunId ?? draft.extractionId);
  const changeArgs: Record<string, Record<string, string>> = {
    REQUEST_REVISED: { now: String(basis.currentRequestRevision ?? "?") },
    NEWER_QUOTE_VERSION: { now: String(basis.latestVersionNumber ?? "?"), then: String(s.versionNumber) },
    BASIS_NOT_USABLE: { code: basis.refusal ?? "" },
  };

  return (
    <main className="page wide draft-page">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">Procurement requests</Link> / <Link href={`/procurements/${id}`}>{shortProcurementId(id)}</Link> /{" "}
        <Link href={`/procurements/${id}/quotes?series=${draft.seriesId}&version=${draft.versionId}`}>Quotes</Link> / <Link href={compareHref}>{en.comparison.crumb}</Link> / {t.crumb}
      </p>
      <h1 className="title-break">
        {t.title} {t.titleZh} · {record.title}
      </h1>
      <section className="card alert warn draft-banner" data-testid="draft-banner">
        <p>
          <strong>{t.banner}</strong> · <strong lang="zh-CN">{t.bannerZh}</strong>
        </p>
        <p className="small">{t.bannerNote}</p>
      </section>

      {basis.changes.length > 0 ? (
        <section className="card alert error-box" data-testid="basis-changed" data-changes={basis.changes.join(" ")}>
          <h2>{t.changed.title as string}</h2>
          <ul>
            {basis.changes.map((c) => (
              <li key={c} data-change={c}>
                {changeText(c, changeArgs[c] ?? {})}
              </li>
            ))}
          </ul>
          <p className="small">{t.changed.kept as string}</p>
          {regenerateRun ? (
            <RegenerateButton createUrl={createUrl} run={regenerateRun} baseRun={draft.baseExtractionId} supersedes={draft.id} />
          ) : (
            <Link href={compareHref}>{t.changed.toCompare as string}</Link>
          )}
        </section>
      ) : null}

      <section className="card" aria-label={t.basisHeading} data-testid="draft-basis">
        <h2>{t.basisHeading}</h2>
        <ul className="small">
          <li>{t.basis.generated(utc(draft.createdAt))}</li>
          <li>{t.basis.quote(s.versionNumber, s.latestVersionNumber)}</li>
          <li>{t.basis.request(s.snapshotRevision, s.currentRequestRevision)}</li>
          <li>
            {t.basis.run(utc(s.run.startedAt), s.run.mode === "MOCK" ? "MOCK" : en.extraction.livePill, `${s.run.provider} / ${s.run.model}`)}
            {s.run.mode === "MOCK" ? <span className="pill source-demo"> {en.comparison.basis.mockNote}</span> : null}
          </li>
        </ul>
        {draft.supersedesId ? (
          <p className="small">
            {t.basis.supersedes} <Link href={`/procurements/${id}/quotes/drafts/${draft.supersedesId}`}>{t.basis.openDraft}</Link>
          </p>
        ) : null}
        {view.successors.length > 0 ? (
          <p className="small" data-testid="draft-successors">
            {t.basis.successor}{" "}
            {view.successors.map((sid) => (
              <Link key={sid} href={`/procurements/${id}/quotes/drafts/${sid}`}>
                {t.basis.openDraft}
              </Link>
            ))}
          </p>
        ) : null}
        <details className="small">
          <summary>{t.basis.details}</summary>
          <ul>
            <li>{t.basis.versions(draft.templateVersion, draft.comparatorVersion, BILINGUAL_CHECK_RULES)}</li>
            <li>{t.basis.textHash(s.rawTextSha256.slice(0, 16))}</li>
            <li>
              Draft <code>{draft.id}</code> · quote version <code>{draft.versionId}</code> · run <code>{s.run.id}</code>
              {s.baseRun ? (
                <>
                  {" "}
                  · base run <code>{s.baseRun.id}</code> (version {s.baseRun.versionNumber})
                </>
              ) : null}
            </li>
            {s.reviews.map((r) => (
              <li key={r.runId}>
                <code>{r.runId.slice(0, 11)}…</code> {t.basis.reviews(r.count)}
              </li>
            ))}
            <li>
              {en.comparison.basis.comparator(s.comparatorVersion, s.asOf)}
            </li>
          </ul>
        </details>
      </section>

      <DraftEditor
        apiBase={`/api/procurements/${id}/clarification-drafts/${draft.id}`}
        draftId={draft.id}
        generated={draft.generated}
        initial={view.initial.content}
        latest={{ revision: view.latest.revision, content: view.latest.content }}
      />
      <ReplyTracker
        apiBase={`/api/procurements/${id}/clarification-drafts/${draft.id}`}
        seriesApi={`/api/procurements/${id}/quotes/${draft.seriesId}`}
        draftId={draft.id}
        generated={draft.generated}
        initial={replies}
        quotesHref={`/procurements/${id}/quotes?series=${draft.seriesId}&version=${draft.versionId}`}
      />
      <p className="hint">{t.footer}</p>
    </main>
  );
}
