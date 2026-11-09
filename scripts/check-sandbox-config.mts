// Checks .env.local for the PayPal Sandbox demo WITHOUT printing any value.
//   npm run check:sandbox
// 1. presence / format of required variables (same rules as the app, src/server/payments/config.ts)
// 2. one OAuth client-credentials request to the Sandbox token endpoint (proves the pair is a valid
//    Sandbox credential). The token is discarded, never printed or stored.

import { existsSync } from "node:fs";
import { REQUIRED_ENV, SANDBOX_API_BASE, readPayPalConfig } from "../src/server/payments/config.ts";

const envFile = ".env.local";
if (!existsSync(envFile)) {
  console.log(`FAIL  ${envFile} not found in ${process.cwd()} (copy .env.example to .env.local and fill it in)`);
  process.exit(1);
}
process.loadEnvFile(envFile);

const names = ["PAYPAL_ENVIRONMENT", ...REQUIRED_ENV];
for (const name of names) {
  const value = (process.env[name] ?? "").trim();
  console.log(`${value ? "set    " : "MISSING"}  ${name}${value ? ` (${value.length} chars)` : ""}`);
}

const cfg = readPayPalConfig();
if (!cfg.configured) {
  for (const e of cfg.errors) console.log(`FAIL  ${e}`);
  if (cfg.missing.length) console.log(`FAIL  missing: ${cfg.missing.join(", ")}`);
  process.exit(1);
}
console.log("PASS  format checks (Sandbox enforced)");

const response = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
const body = (await response.json().catch(() => ({}))) as { token_type?: string; access_token?: string; expires_in?: number; error?: string };
if (response.ok && body.token_type === "Bearer" && typeof body.access_token === "string") {
  console.log(`PASS  Sandbox OAuth token obtained from ${SANDBOX_API_BASE} (HTTP ${response.status}); token discarded`);
} else {
  console.log(`FAIL  Sandbox OAuth request: HTTP ${response.status}${body.error ? ` (${body.error})` : ""}. Check that the Client ID/Secret are from the SANDBOX app.`);
  process.exit(1);
}
