// Server-only entry point used by the search route handler and the list page.
import "server-only";

import { APP_DB_PATH } from "../db/location.ts";
import { SearchStore } from "./store.ts";

// Same local SQLite file. Opened lazily, never at import or build time; kept on globalThis so dev
// hot-reloads reuse one connection.
const holder = globalThis as typeof globalThis & { __tradeproofSearch?: SearchStore };

export function getSearchStore(): SearchStore {
  holder.__tradeproofSearch ??= new SearchStore(APP_DB_PATH, { onBackup: (file) => console.info(`[db] backup written before migration: ${file}`) });
  return holder.__tradeproofSearch;
}
