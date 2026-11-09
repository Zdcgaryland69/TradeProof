import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getReplyService } from "@/server/replies";
import { handleSaveReply } from "@/server/replies/http";

type Params = { params: Promise<{ id: string; seriesId: string }> };

// POST saves a supplier reply text for this quote (kept as received; not a quote version). Nothing is sent.
export async function POST(req: Request, { params }: Params) {
  const { id, seriesId } = await params;
  return handleSaveReply(req, id, seriesId, getReplyService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
