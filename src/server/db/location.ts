import path from "node:path";

/** The app's main local database file (Git-ignored). Historically named after the Sandbox payment records. */
export const DEFAULT_APP_DB_PATH = path.join(process.cwd(), "data", "sandbox-payments.sqlite");

/**
 * Local database file. Since schema v4 it also holds the procurement tables. `TRADEPROOF_DB_PATH` points the app at
 * another file (30 Oct: a consistent copy for MOCK payment checks, so MOCK records never enter the main file). Only a
 * path: nothing is opened here.
 */
export const APP_DB_PATH = process.env.TRADEPROOF_DB_PATH ? path.resolve(process.env.TRADEPROOF_DB_PATH) : DEFAULT_APP_DB_PATH;
