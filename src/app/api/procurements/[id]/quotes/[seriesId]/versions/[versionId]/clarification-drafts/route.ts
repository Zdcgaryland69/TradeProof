import { getAuthGate } from "@/server/auth";
import { getClarificationService } from "@/server/clarification";
import { handleCreateDraft, handleListDrafts } from "@/server/clarification/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; seriesId: string; versionId: string }> };

// GET lists this version's drafts; POST generates one from the stored comparison (names a run only). Neither calls a model.
export async function GET(req: Request, { params }: Params) {
  const { id, seriesId, versionId } = await params;
  return handleListDrafts(req, id, seriesId, versionId, getClarificationService, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function POST(req: Request, { params }: Params) {
  const { id, seriesId, versionId } = await params;
  return handleCreateDraft(req, id, seriesId, versionId, getClarificationService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
