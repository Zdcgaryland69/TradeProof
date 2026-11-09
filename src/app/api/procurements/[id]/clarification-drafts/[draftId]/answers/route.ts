import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getReplyService } from "@/server/replies";
import { handleAnswer } from "@/server/replies/http";

type Params = { params: Promise<{ id: string; draftId: string }> };

// POST records the user's reading of a reply for one question (append-only, conflict-checked). Nothing is sent.
export async function POST(req: Request, { params }: Params) {
  const { id, draftId } = await params;
  return handleAnswer(req, id, draftId, getReplyService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
