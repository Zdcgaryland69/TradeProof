import { getAuthGate } from "@/server/auth";
import { getCopilotService } from "@/server/copilot";
import { handleAsk } from "@/server/copilot/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string }> };

// POST: one of the five Copilot questions about this record (ids + intent only). Facts are computed read-only; a model
// is called only when the server allows it (MOCK, or LIVE with TRADEPROOF_COPILOT_LIVE=on and the shared budget).
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return handleAsk(req, id, getCopilotService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
