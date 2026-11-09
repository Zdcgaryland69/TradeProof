import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getQuoteStore } from "@/server/quotes";
import { handleGetVersion } from "@/server/quotes/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; seriesId: string; versionId: string }> }) {
  const { id, seriesId, versionId } = await params;
  return handleGetVersion(req, id, seriesId, versionId, getQuoteStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
