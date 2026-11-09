import { getAuthGate } from "@/server/auth";
import { getClarificationService } from "@/server/clarification";
import { handleGetDraft, handleSaveDraft } from "@/server/clarification/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; draftId: string }> };

// GET reads a draft (no generation, no write); PUT saves the user's edit with a revision check. Nothing is sent.
export async function GET(req: Request, { params }: Params) {
  const { id, draftId } = await params;
  return handleGetDraft(req, id, draftId, getClarificationService, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function PUT(req: Request, { params }: Params) {
  const { id, draftId } = await params;
  return handleSaveDraft(req, id, draftId, getClarificationService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
