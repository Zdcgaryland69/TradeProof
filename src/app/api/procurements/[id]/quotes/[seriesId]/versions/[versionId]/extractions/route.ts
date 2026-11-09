import { getAuthGate } from "@/server/auth";
import { getExtractionService } from "@/server/extraction";
import { handleListExtractions, handleRunExtraction } from "@/server/extraction/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; seriesId: string; versionId: string }> };

export async function GET(req: Request, { params }: Params) {
  const { id, seriesId, versionId } = await params;
  return handleListExtractions(req, id, seriesId, versionId, getExtractionService, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function POST(req: Request, { params }: Params) {
  const { id, seriesId, versionId } = await params;
  return handleRunExtraction(req, id, seriesId, versionId, getExtractionService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
