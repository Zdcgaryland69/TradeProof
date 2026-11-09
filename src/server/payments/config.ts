// PayPal configuration for this phase. Sandbox is enforced: there is no code path to Live.
// Secrets are read from the environment (.env.local) on the server only and never returned.

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

export const REQUIRED_ENV = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_EXPECTED_PAYEE_MERCHANT_ID"] as const;

export type PayPalConfig =
  | {
      configured: true;
      clientId: string;
      clientSecret: string;
      payeeMerchantId: string;
    }
  | {
      configured: false;
      missing: string[];
      errors: string[];
    };

/** What the browser may see: never the secret. */
export interface PublicPayPalConfig {
  configured: boolean;
  environment: "sandbox";
  clientId: string | null;
  missing: string[];
  errors: string[];
}

type Env = Record<string, string | undefined>;

export function readPayPalConfig(env: Env = process.env): PayPalConfig {
  const errors: string[] = [];
  const environment = (env.PAYPAL_ENVIRONMENT ?? "").trim();
  if (environment !== "sandbox") {
    errors.push('PAYPAL_ENVIRONMENT must be "sandbox" (Live is not supported in this phase)');
  }
  const apiBase = (env.PAYPAL_API_BASE ?? "").trim();
  if (apiBase && apiBase.replace(/\/+$/, "") !== SANDBOX_API_BASE) {
    errors.push(`PAYPAL_API_BASE, if set, must be ${SANDBOX_API_BASE}`);
  }
  const missing = REQUIRED_ENV.filter((name) => !(env[name] ?? "").trim());
  const merchantId = (env.PAYPAL_EXPECTED_PAYEE_MERCHANT_ID ?? "").trim();
  if (merchantId && !/^[A-Z0-9]{8,20}$/.test(merchantId)) {
    errors.push("PAYPAL_EXPECTED_PAYEE_MERCHANT_ID should be the 13-character Sandbox Business account ID (letters/digits)");
  }
  if (missing.length > 0 || errors.length > 0) return { configured: false, missing: [...missing], errors };
  return {
    configured: true,
    clientId: env.PAYPAL_CLIENT_ID!.trim(),
    clientSecret: env.PAYPAL_CLIENT_SECRET!.trim(),
    payeeMerchantId: merchantId,
  };
}

export function publicConfig(cfg: PayPalConfig): PublicPayPalConfig {
  return cfg.configured
    ? { configured: true, environment: "sandbox", clientId: cfg.clientId, missing: [], errors: [] }
    : { configured: false, environment: "sandbox", clientId: null, missing: cfg.missing, errors: cfg.errors };
}
