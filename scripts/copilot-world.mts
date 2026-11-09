// The production read-only sources of the Copilot on one database file, for scripts (cost bounds, case preview,
// acceptance runner). Opening a file migrates it to the current schema (with a backup), like the app does.
import { ApprovalService } from "../src/server/approval/service.ts";
import { ApprovalStore } from "../src/server/approval/store.ts";
import { ClarificationService } from "../src/server/clarification/service.ts";
import { ClarificationStore } from "../src/server/clarification/store.ts";
import { ComparisonService } from "../src/server/comparison/service.ts";
import type { CopilotSources } from "../src/server/copilot/facts.ts";
import { ExtractionStore } from "../src/server/extraction/store.ts";
import { ProcurementStore } from "../src/server/procurement/store.ts";
import { QuoteStore } from "../src/server/quotes/store.ts";
import { ReplyService } from "../src/server/replies/service.ts";
import { ReplyStore } from "../src/server/replies/store.ts";
import { replayModel, replayService } from "../tests/helpers/approval-fixtures.ts";

export function openWorld(path: string, opts: { approverAssigned?: (requestId: string) => boolean } = {}) {
  const ps = new ProcurementStore(path);
  const qs = new QuoteStore(path);
  const es = new ExtractionStore(path);
  const cs = new ClarificationStore(path);
  const rs = new ReplyStore(path);
  const aps = new ApprovalStore(path);
  const model = replayModel();
  const svc = replayService(es, model);
  const replies = new ReplyService(rs, cs);
  const comparison = new ComparisonService(es);
  // No payment can start from these scripts: the payment service is never created.
  const approvals = new ApprovalService({ store: aps, extraction: es, procurement: ps, replies, replyStore: rs, drafts: cs, payments: () => { throw new Error("no payments in Copilot scripts"); }, payee: () => ({ configured: true, merchantId: "MOCKPAYEE0001" }) });
  const clar = new ClarificationService(cs, comparison);
  const src: CopilotSources = { procurement: ps, quotes: qs, comparison, approvals, clarification: clar, replies, approverAssigned: opts.approverAssigned ?? (() => false), paymentsEnabled: () => false };
  return { path, ps, qs, es, cs, rs, aps, model, svc, replies, comparison, approvals, clar, src, close: () => [ps, qs, es, cs, rs, aps].forEach((x) => x.close()) };
}
