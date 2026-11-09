import { getAuthGate } from "@/server/auth";
import { getCopilotService } from "@/server/copilot";
import { handleBasis } from "@/server/copilot/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string }> };

// GET: the current basis of this record (hashed parts) — no model call, no business write. The panel uses it on focus
// and on "Check" to clear answers after sign-out / loss of access and to mark answers outdated.
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  return handleBasis(req, id, getCopilotService, { enabled: procurementEnabled(), auth: getAuthGate() });
}
