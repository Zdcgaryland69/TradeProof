// The single fixed test item for the Sandbox payment spike. The server is the only source of
// amount and currency; nothing the browser sends can change them.

export interface TestItem {
  sku: string;
  name: string;
  amountMinor: number;
  currency: string;
}

export const SANDBOX_TEST_ITEM: Readonly<TestItem> = Object.freeze({
  sku: "TP-DEMO-SAMPLE-001",
  name: "TradeProof demo sample (fictional, Sandbox only)",
  amountMinor: 100, // USD 1.00
  currency: "USD",
});
