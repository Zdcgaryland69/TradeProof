// Server-only entry point used by the supplier-reply route handlers and the draft page.
import "server-only";

import { getClarificationStore } from "../clarification/index.ts";
import { APP_DB_PATH } from "../db/location.ts";
import { ReplyService } from "./service.ts";
import { ReplyStore } from "./store.ts";

// Same local SQLite file (schema v11). Opened lazily, never at import or build time; kept on globalThis so
// dev hot-reloads reuse one connection. No model or PayPal client is created here.
const holder = globalThis as typeof globalThis & { __tradeproofReplies?: ReplyService };

export function getReplyService(): ReplyService {
  holder.__tradeproofReplies ??= new ReplyService(
    new ReplyStore(APP_DB_PATH, { onBackup: (file) => console.info(`[db] backup written before migration: ${file}`) }),
    getClarificationStore(),
  );
  return holder.__tradeproofReplies;
}
