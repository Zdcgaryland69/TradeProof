// Server-only entry point used by the clarification-draft route handlers and pages.
import "server-only";

import { getComparisonService } from "../comparison/index.ts";
import { APP_DB_PATH } from "../db/location.ts";
import { ClarificationService } from "./service.ts";
import { ClarificationStore } from "./store.ts";

// Same local SQLite file (schema v10+). Opened lazily, never at import or build time; kept on globalThis so
// dev hot-reloads reuse one connection. No model or PayPal client is created here.
const holder = globalThis as typeof globalThis & { __tradeproofClarification?: ClarificationService; __tradeproofClarificationStore?: ClarificationStore };

/** The draft store, shared with the supplier-reply service (one connection). */
export function getClarificationStore(): ClarificationStore {
  holder.__tradeproofClarificationStore ??= new ClarificationStore(APP_DB_PATH, { onBackup: (file) => console.info(`[db] backup written before migration: ${file}`) });
  return holder.__tradeproofClarificationStore;
}

export function getClarificationService(): ClarificationService {
  holder.__tradeproofClarification ??= new ClarificationService(getClarificationStore(), getComparisonService());
  return holder.__tradeproofClarification;
}
