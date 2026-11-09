import { getAuthGate } from "@/server/auth";
import { approvalPaymentsEnabled, approvalPaymentsRefusedReason, getApprovalService } from "@/server/approval";
import { handleView } from "@/server/approval/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; approvalId: string }> };

export async function GET(req: Request, { params }: Params) {
  const { id, approvalId } = await params;
  return handleView(req, id, approvalId, getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate(), paymentsEnabled: approvalPaymentsEnabled(), paymentsRefusedReason: approvalPaymentsRefusedReason() });
}
