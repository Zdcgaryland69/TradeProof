import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/server/auth";
import { requireLocalDev } from "../procurements/local-only";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in — TradeProof",
  robots: { index: false, follow: false },
};

// Local demo accounts only (Buyer A, Buyer B, Approver), created by the local operator script. No registration,
// password reset or third-party sign-in.
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireLocalDev();
  const raw = (await searchParams).next;
  const next = typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/procurements";
  if (await currentPrincipal()) redirect(next);
  return (
    <main className="page">
      <h1>Sign in 登录</h1>
      <p className="small muted">Local demo with three preset accounts (Buyer A, Buyer B, Approver). There is no registration or password reset. Sessions end after 60 minutes without activity or 8 hours at most.</p>
      <LoginForm next={next} />
    </main>
  );
}
