// Pre-flight for an authorised live Copilot run: resolves what the runner will use (after .env.local); prints states / booleans only, never values.
import nextEnv from "@next/env";
import { DatabaseSync } from "node:sqlite";
nextEnv.loadEnvConfig(process.cwd());
const { resolveExtractionModel } = await import("../src/server/extraction/model.ts");
const { resolveBudgetConfig } = await import("../src/server/budget/config.ts");
const { approvalPaymentMode } = await import("../src/server/approval/payment-mode.ts");
const { budgetDay } = await import("../src/lib/budget.ts");
const m = resolveExtractionModel();
const out: Record<string, unknown> = { model: m.config.state === "READY" ? `${m.config.mode} ${m.config.provider} ${m.config.model}` : "NOT_CONFIGURED" };
if (m.model) {
  const b = resolveBudgetConfig(m.model.provider, m.model.model);
  out.budget = b.ok ? "OK" : `REFUSED (${b.missing.length} missing, ${b.problems.length} problems)`;
  if (b.ok) {
    const db = new DatabaseSync(process.argv[2], { readOnly: true });
    const basis = JSON.parse(String((db.prepare("SELECT price_basis FROM ai_budget_ledger ORDER BY reserved_at LIMIT 1").get() as { price_basis: string }).price_basis));
    const day = budgetDay(new Date());
    const today = db.prepare("SELECT count(*) n FROM ai_budget_ledger WHERE budget_day = ? AND state <> 'RELEASED'").get(day) as { n: number };
    db.close();
    const c = b.config;
    out.currencyUSD = c.currency === "USD";
    out.pricesEqualLedgerBasis = JSON.stringify(c.prices) === JSON.stringify(basis);
    out.limitsAsApproved = c.limits.dailyMicros === 1_000_000 && c.limits.dailyCalls === 20 && c.limits.totalMicros === 5_000_000 && c.limits.totalCalls === 100;
    out.budgetDaySGT = day;
    out.callsCountedToday = today.n;
  }
}
out.copilotLiveSwitch = (process.env.TRADEPROOF_COPILOT_LIVE ?? "") === "on" ? "ON (this process only)" : "off";
out.approvalPayments = approvalPaymentMode(process.env, "x", "x").mode;
console.log(JSON.stringify(out, null, 1));
