import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { shortProcurementId } from "@/lib/procurement";
import { getProcurementStore } from "@/server/procurement";
import { PROCUREMENT_ID } from "@/server/procurement/store";
import { getQuoteStore } from "@/server/quotes";
import { loadQuoteDemoSamples } from "@/server/quotes/demo";
import { canApproveRequest, canAssignApprover, canReadRequest, canWriteRequest } from "@/server/access/policy";
import { getAuthService } from "@/server/auth";
import { currentApprovalPaymentMode } from "@/server/approval";
import { requireSignedInPage } from "../../local-only";
import QuoteWorkspace from "./QuoteWorkspace";

export const metadata: Metadata = {
  title: "Quotes — TradeProof",
  robots: { index: false, follow: false },
};

export default async function QuotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireSignedInPage("/procurements");
  const { id } = await params;
  if (!PROCUREMENT_ID.test(id) || !canReadRequest(me, id)) notFound();
  const record = getProcurementStore().get(id);
  if (!record) notFound();
  const series = getQuoteStore().listSeries(id);
  const query = await searchParams;
  const pick = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);
  const owner = canAssignApprover(me, id) ? getAuthService().approverState(id) : null;

  return (
    <main className="page wide quotes-page">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">Procurement requests</Link> /{" "}
        <Link href={`/procurements/${record.id}`}>{shortProcurementId(record.id)}</Link> / Quotes
      </p>
      <header className="page-head">
        <h1>
          Quotes <span lang="zh-CN">报价</span>
        </h1>
        <p className="page-subject">{record.title}</p>
      </header>
      <p className="small muted">
        <strong className="ref">{shortProcurementId(record.id)}</strong> · request revision {record.revision} · Paste supplier quote text and keep every
        version. Saving a quote does not confirm, accept or approve it, and does not allow payment.
      </p>
      <QuoteWorkspace
        key={record.id}
        record={record}
        initialSeries={series}
        demos={loadQuoteDemoSamples()}
        initialSeriesId={pick(query.series)}
        initialVersionId={pick(query.version)}
        readOnly={!canWriteRequest(me, id)}
        approval={{
          // The assigned approver approves; the owning buyer sees preview and status only (the server checks again).
          role: canApproveRequest(me, id) ? "APPROVER" : "OWNER",
          approverAssigned: owner ? owner.some((a) => a.assigned) : null,
          // 5 Nov: who the buyer is waiting for (owner only) and the server's payment switch, both display only.
          approverName: owner ? (owner.find((a) => a.assigned)?.displayName ?? null) : null,
          paymentMode: currentApprovalPaymentMode().mode,
        }}
      />
    </main>
  );
}
