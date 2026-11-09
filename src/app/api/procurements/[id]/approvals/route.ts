import { getAuthGate } from "@/server/auth";
import { getApprovalService } from "@/server/approval";
import { handleApprove, handlePreview } from "@/server/approval/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string }> };

// GET: preview (series / version / run named) or the list of approvals. Computing a preview writes nothing.
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  return handlePreview(req, id, getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate() });
}

// POST: approve. The server recomputes the preview and stores it only if the digest and confirmations match.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return handleApprove(req, id, getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
