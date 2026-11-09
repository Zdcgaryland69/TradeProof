import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getQuoteStore } from "@/server/quotes";
import { handleAddVersion } from "@/server/quotes/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; seriesId: string }> }) {
  const { id, seriesId } = await params;
  return handleAddVersion(req, id, seriesId, getQuoteStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
