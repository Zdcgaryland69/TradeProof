import { getAuthGate } from "@/server/auth";
import { getApprovalService } from "@/server/approval";
import { handleClassify } from "@/server/approval/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; seriesId: string; versionId: string }> };

// POST: the buyer's classification of a free-text requirement (item notes / additional requirements) for this version.
export async function POST(req: Request, { params }: Params) {
  const { id, seriesId, versionId } = await params;
  return handleClassify(req, id, seriesId, versionId, getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
