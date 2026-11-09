import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getPaymentService, getPublicPayPalConfig, sandboxDemoEnabled } from "@/server/payments";
import { SANDBOX_TEST_ITEM } from "@/server/payments/catalog";
import { recordView } from "@/server/payments/http";
import { formatMinorUnits } from "@/server/payments/money";
import SandboxDemo from "./SandboxDemo";

export const metadata: Metadata = {
  title: "Sandbox payment demo — TradeProof",
  robots: { index: false, follow: false },
};

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export default async function SandboxDemoPage() {
  await connection(); // always rendered per request (reads the local DB)
  if (!sandboxDemoEnabled()) notFound();
  const host = (await headers()).get("host") ?? "";
  if (!LOCAL_HOST.test(host)) notFound();

  const config = getPublicPayPalConfig();
  const records = getPaymentService().listRecords(10).map((r) => recordView(r)!);
  const item = {
    sku: SANDBOX_TEST_ITEM.sku,
    name: SANDBOX_TEST_ITEM.name,
    amount: `${SANDBOX_TEST_ITEM.currency} ${formatMinorUnits(SANDBOX_TEST_ITEM.amountMinor, SANDBOX_TEST_ITEM.currency)}`,
  };

  return (
    <main className="page">
      <p className="sandbox-banner" role="note">
        SANDBOX / DEMO · 测试环境 · fictional item · no real money · local-only page
      </p>
      <h1>Sandbox payment check</h1>
      <p className="tagline">
        Minimal PayPal Sandbox loop<span className="zh">最小支付闭环（技术验证，不是完整采购审批）</span>
      </p>
      <SandboxDemo config={config} item={item} initialRecords={records} />
    </main>
  );
}
