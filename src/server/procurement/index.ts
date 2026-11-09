// Server-only entry point used by procurement route handlers and pages.
import "server-only";

import { APP_DB_PATH } from "../db/location.ts";
import { ProcurementStore } from "./store.ts";

// Procurement tables share the local SQLite file with the Sandbox payment records (separate tables, schema v4).

// Kept on globalThis so dev hot-reloads reuse one connection. Opened lazily: never at import or build time.
const holder = globalThis as typeof globalThis & { __tradeproofProcurement?: ProcurementStore };

export function getProcurementStore(): ProcurementStore {
  holder.__tradeproofProcurement ??= new ProcurementStore(APP_DB_PATH, {
    onBackup: (file) => console.info(`[db] backup written before migration: ${file}`),
  });
  return holder.__tradeproofProcurement;
}

export { localDevFeaturesEnabled as procurementEnabled } from "../http/local-guard.ts";
