import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getReplyService } from "@/server/replies";
import { handleLinkQuote } from "@/server/replies/http";

type Params = { params: Promise<{ id: string; seriesId: string; replyId: string }> };

// POST records that this reply led to an updated quote version (append-only). Nothing is extracted or compared here.
export async function POST(req: Request, { params }: Params) {
  const { id, seriesId, replyId } = await params;
  return handleLinkQuote(req, id, seriesId, replyId, getReplyService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
