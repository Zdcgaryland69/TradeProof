// Server-only entry point used by the Copilot route handlers.
import "server-only";

import { getApprovalService, approvalPaymentsEnabled , currentApprovalPaymentMode } from "../approval/index.ts";
import { getAuthService } from "../auth/index.ts";
import { BudgetStore } from "../budget/store.ts";
import { getClarificationService } from "../clarification/index.ts";
import { getComparisonService } from "../comparison/index.ts";
import { APP_DB_PATH } from "../db/location.ts";
import { getProcurementStore } from "../procurement/index.ts";
import { getQuoteStore } from "../quotes/index.ts";
import { getReplyService } from "../replies/index.ts";
import { CopilotService } from "./service.ts";

// Same local SQLite file. Opened lazily, never at import or build time; kept on globalThis so dev hot-reloads reuse one
// service. The model configuration and TRADEPROOF_COPILOT_LIVE are read per ask; nothing here calls a model.
const holder = globalThis as typeof globalThis & { __tradeproofCopilot?: CopilotService };

export function getCopilotService(): CopilotService {
  holder.__tradeproofCopilot ??= new CopilotService(
    {
      procurement: getProcurementStore(),
      quotes: getQuoteStore(),
      comparison: getComparisonService(),
      approvals: getApprovalService(),
      clarification: getClarificationService(),
      replies: getReplyService(),
      approverAssigned: (requestId) => getAuthService().approverState(requestId).some((a) => a.assigned),
      paymentsEnabled: () => approvalPaymentsEnabled(),
      paymentMode: () => currentApprovalPaymentMode().mode,
    },
    { budget: new BudgetStore(APP_DB_PATH) },
  );
  return holder.__tradeproofCopilot;
}
