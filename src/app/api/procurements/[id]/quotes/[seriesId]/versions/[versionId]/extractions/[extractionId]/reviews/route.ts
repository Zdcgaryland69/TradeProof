import { getAuthGate } from "@/server/auth";
import { getExtractionService } from "@/server/extraction";
import { handleReviewExtraction } from "@/server/extraction/http";
import { procurementEnabled } from "@/server/procurement";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; seriesId: string; versionId: string; extractionId: string }> }) {
  const { id, seriesId, versionId, extractionId } = await params;
  return handleReviewExtraction(req, id, seriesId, versionId, extractionId, getExtractionService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
