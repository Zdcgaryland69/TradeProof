// Server-only entry point used by the comparison route handler and page.
import "server-only";

import { APP_DB_PATH } from "../db/location.ts";
import { ExtractionStore } from "../extraction/store.ts";
import { ComparisonService } from "./service.ts";

// Same local SQLite file, used read-only here (no run, review or model call can start from this service).
// Opened lazily, never at import or build time; kept on globalThis so dev hot-reloads reuse one connection.
const holder = globalThis as typeof globalThis & { __tradeproofComparison?: ComparisonService };

export function getComparisonService(): ComparisonService {
  holder.__tradeproofComparison ??= new ComparisonService(
    new ExtractionStore(APP_DB_PATH, { onBackup: (file) => console.info(`[db] backup written before migration: ${file}`) }),
  );
  return holder.__tradeproofComparison;
}
