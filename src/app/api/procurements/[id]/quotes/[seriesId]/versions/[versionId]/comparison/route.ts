import { getAuthGate } from "@/server/auth";
import { getComparisonService } from "@/server/comparison";
import { handleComparison } from "@/server/comparison/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; seriesId: string; versionId: string }> };

// GET only: a comparison is computed from stored records; it never starts an extraction or a model call.
export async function GET(req: Request, { params }: Params) {
  const { id, seriesId, versionId } = await params;
  return handleComparison(req, id, seriesId, versionId, getComparisonService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
