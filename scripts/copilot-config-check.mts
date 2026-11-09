// Prints how the app would resolve its AI / Copilot / payment configuration under the CURRENT process environment plus
// .env.local, using the same loader as `next dev` (@next/env) and the app's own resolvers. States only — never values.
//   AI_PROVIDER=mock TRADEPROOF_APPROVAL_PAYMENTS= TRADEPROOF_COPILOT_LIVE= TRADEPROOF_DB_PATH=<copy> \
//     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-config-check.mts
import nextEnv from "@next/env";

const before = { AI_PROVIDER: process.env.AI_PROVIDER, payments: process.env.TRADEPROOF_APPROVAL_PAYMENTS, live: process.env.TRADEPROOF_COPILOT_LIVE };
const loaded = nextEnv.loadEnvConfig(process.cwd());
const { resolveExtractionModel } = await import("../src/server/extraction/model.ts");
const { approvalPaymentMode } = await import("../src/server/approval/payment-mode.ts");
const { APP_DB_PATH, DEFAULT_APP_DB_PATH } = await import("../src/server/db/location.ts");
const m = resolveExtractionModel();
const files = loaded.loadedEnvFiles.map((f) => f.path);
console.log(
  JSON.stringify(
    {
      envFiles: files,
      setBeforeLoading: { AI_PROVIDER: before.AI_PROVIDER === undefined ? "unset" : "set", TRADEPROOF_APPROVAL_PAYMENTS: before.payments === undefined ? "unset" : before.payments === "" ? "empty" : "set", TRADEPROOF_COPILOT_LIVE: before.live === undefined ? "unset" : before.live === "" ? "empty" : "set" },
      extractionModel: m.config.state === "READY" ? `READY ${m.config.mode} (${m.config.provider})` : `NOT_CONFIGURED`,
      copilotLiveSwitch: (process.env.TRADEPROOF_COPILOT_LIVE ?? "").trim() === "on" ? "ON" : "off",
      approvalPayments: approvalPaymentMode(process.env, APP_DB_PATH, DEFAULT_APP_DB_PATH).mode,
      database: APP_DB_PATH.toLowerCase() === DEFAULT_APP_DB_PATH.toLowerCase() ? "MAIN DB" : "a copy (TRADEPROOF_DB_PATH)",
    },
    null,
    1,
  ),
);
