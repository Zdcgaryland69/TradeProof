// The one entry for reading "the current record, as the current user may see it" (30 Oct). Reserved for the future
// Copilot (product brief §4a): it gets a record's data only through this function, never by id alone. Nothing here
// calls a model; no caller sends its result anywhere yet.

import type { ProcurementRecord } from "../../lib/procurement.ts";
import type { QuoteSeries } from "../../lib/quote-versions.ts";
import type { ProcurementStore } from "../procurement/store.ts";
import type { QuoteStore } from "../quotes/store.ts";
import { canReadRequest, type Principal } from "./policy.ts";

export interface RecordContext {
  record: ProcurementRecord;
  series: QuoteSeries[];
  /** What the viewer may do; the model would only explain, never act. */
  viewer: { role: Principal["kind"]; canWrite: boolean };
}

/** null = not readable for this principal, or not existing (indistinguishable to the caller). */
export function readRecordFor(principal: Principal, requestId: string, stores: { procurement: ProcurementStore; quotes: QuoteStore }): RecordContext | null {
  if (!canReadRequest(principal, requestId)) return null;
  const record = stores.procurement.get(requestId);
  if (!record) return null;
  return { record, series: stores.quotes.listSeries(requestId), viewer: { role: principal.kind, canWrite: principal.kind === "BUYER" } };
}
