import { getAuthGate } from "@/server/auth";
import { getApprovalService, getMockApprovalPayments } from "@/server/approval";
import { handleMockApprove } from "@/server/approval/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; approvalId: string }> };

// MOCK mode only (database copy): simulates the buyer's approval of the MOCK order. 404 in every other mode.
export async function POST(req: Request, { params }: Params) {
  const { id, approvalId } = await params;
  return handleMockApprove(req, id, approvalId, getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate(), mock: getMockApprovalPayments()?.gateway ?? null });
}
