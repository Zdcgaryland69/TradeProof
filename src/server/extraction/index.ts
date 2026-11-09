// Server-only entry point used by the extraction route handlers and pages.
import "server-only";

import { BudgetStore } from "../budget/store.ts";
import { APP_DB_PATH } from "../db/location.ts";
import { ExtractionService } from "./service.ts";
import { ExtractionStore } from "./store.ts";

// Same local SQLite file as the quotes (schema v7). Opened lazily, never at import or build time; kept on
// globalThis so dev hot-reloads reuse one connection. The model configuration is read per call from the
// environment (names are reported, values never are).
const holder = globalThis as typeof globalThis & { __tradeproofExtraction?: ExtractionService };

export function getExtractionService(): ExtractionService {
  holder.__tradeproofExtraction ??= new ExtractionService(
    new ExtractionStore(APP_DB_PATH, { onBackup: (file) => console.info(`[db] backup written before migration: ${file}`) }),
    // Overall API budget ledger (schema v9). The budget itself is read from the environment per call.
    { budget: new BudgetStore(APP_DB_PATH) },
  );
  return holder.__tradeproofExtraction;
}
