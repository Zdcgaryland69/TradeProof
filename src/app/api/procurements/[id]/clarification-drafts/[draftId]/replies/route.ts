import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getReplyService } from "@/server/replies";
import { handleGetReplies, handleLinkReply } from "@/server/replies/http";

type Params = { params: Promise<{ id: string; draftId: string }> };

// GET reads the replies linked to a draft and each question's state; POST links a saved supplier reply to the draft. Nothing is sent.
export async function GET(req: Request, { params }: Params) {
  const { id, draftId } = await params;
  return handleGetReplies(req, id, draftId, getReplyService, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function POST(req: Request, { params }: Params) {
  const { id, draftId } = await params;
  return handleLinkReply(req, id, draftId, getReplyService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
