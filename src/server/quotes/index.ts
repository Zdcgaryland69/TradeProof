// Server-only entry point used by the quote route handlers and pages.
import "server-only";

import { APP_DB_PATH } from "../db/location.ts";
import { QuoteStore } from "./store.ts";

// Same local SQLite file as procurement drafts and payment records (schema v6). Opened lazily, never at
// import or build time; kept on globalThis so dev hot-reloads reuse one connection.
const holder = globalThis as typeof globalThis & { __tradeproofQuotes?: QuoteStore };

export function getQuoteStore(): QuoteStore {
  holder.__tradeproofQuotes ??= new QuoteStore(APP_DB_PATH, {
    onBackup: (file) => console.info(`[db] backup written before migration: ${file}`),
  });
  return holder.__tradeproofQuotes;
}
