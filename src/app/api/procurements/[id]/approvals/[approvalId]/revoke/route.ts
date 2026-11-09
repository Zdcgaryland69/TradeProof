import { getAuthGate } from "@/server/auth";
import { getApprovalService } from "@/server/approval";
import { handleRevoke } from "@/server/approval/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; approvalId: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id, approvalId } = await params;
  return handleRevoke(req, id, approvalId, getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
