import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { shortProcurementId } from "@/lib/procurement";
import { getProcurementStore } from "@/server/procurement";
import { PROCUREMENT_ID } from "@/server/procurement/store";
import { getQuoteStore } from "@/server/quotes";
import { canAssignApprover, canReadRequest, canWriteRequest } from "@/server/access/policy";
import { getAuthService } from "@/server/auth";
import { AccessPanel, AccessSummary } from "./AccessPanel";
import { requireSignedInPage } from "../local-only";
import ProcurementDetail from "./ProcurementDetail";

export const metadata: Metadata = {
  title: "Procurement request — TradeProof",
  robots: { index: false, follow: false },
};

export default async function ProcurementPage({
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
  const justCreated = (await searchParams).saved === "created";
  const quotes = getQuoteStore().listSeries(id);
  const ownerId = me.access.ownerOf(record.id);
  const ownerName = (ownerId && getAuthService().store.account(ownerId)?.displayName) || "—";
  const canManage = canAssignApprover(me, record.id);
  const approvers = canManage ? getAuthService().approverState(record.id).map((a) => ({ ...a, history: a.history.map((h) => ({ seq: h.seq, action: h.action, createdAt: h.createdAt })) })) : [];
  const viewer = `${me.displayName} (${me.kind === "BUYER" ? "buyer" : "approver"})`;

  return (
    <main className="page wide">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">Procurement requests</Link> / {shortProcurementId(record.id)}
      </p>
      {/* 7 Nov: compact access line first; the full Access panel (every approver account) after the request details. */}
      <AccessSummary ownerName={ownerName} assigned={approvers.filter((a) => a.assigned).map((a) => a.displayName)} viewer={viewer} role={canManage ? "OWNER" : me.kind === "APPROVER" ? "APPROVER" : "OTHER"} />
      <ProcurementDetail initialRecord={record} justCreated={justCreated} quotes={quotes} readOnly={!canWriteRequest(me, record.id)} />
      <AccessPanel requestId={record.id} ownerName={ownerName} approvers={approvers} canManage={canManage} viewer={viewer} />
    </main>
  );
}
