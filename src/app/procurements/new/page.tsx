import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { emptyInput } from "@/lib/procurement";
import { loadDemoInput } from "@/server/procurement/demo";
import { canCreateRequest } from "@/server/access/policy";
import { requireSignedInPage } from "../local-only";
import ProcurementEditor from "../ProcurementEditor";

export const metadata: Metadata = {
  title: "New procurement request — TradeProof",
  robots: { index: false, follow: false },
};

export default async function NewProcurementPage() {
  const me = await requireSignedInPage("/procurements/new");
  if (!canCreateRequest(me)) notFound(); // approvers create nothing
  return (
    <main className="page wide">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / <Link href="/procurements">Procurement requests</Link> / New
      </p>
      <h1>New procurement request</h1>
      <p className="tagline">
        Saved as a draft<span className="zh">新建采购需求（草稿）</span>
      </p>
      <ProcurementEditor mode="create" initial={emptyInput()} demo={loadDemoInput()} />
    </main>
  );
}
