// Test budgets. Currency XTS is the ISO 4217 code reserved for testing: these are never real prices.
import type { BudgetConfig, BudgetConfigResult } from "../../src/server/budget/config.ts";

export function testBudget(over: Partial<Omit<BudgetConfig, "limits">> & { limits?: Partial<BudgetConfig["limits"]> } = {}): BudgetConfig {
  return {
    currency: "XTS",
    provider: "fake",
    model: "fake-model",
    ...over,
    limits: { totalMicros: 1_000_000_000, dailyMicros: 1_000_000_000, totalCalls: 10_000, dailyCalls: 10_000, ...over.limits },
    prices: over.prices ?? { inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 2_000_000, perRequestMicros: 0 },
  };
}

/** A resolver that answers for whatever provider / model is configured (as the env resolver would after the owner fills it in). */
export const generousBudget =
  (over: Parameters<typeof testBudget>[0] = {}) =>
  (provider: string, model: string): BudgetConfigResult => ({ ok: true, config: testBudget({ ...over, provider, model }) });
