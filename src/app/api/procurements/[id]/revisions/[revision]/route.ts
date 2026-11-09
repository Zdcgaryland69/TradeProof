import { getAuthGate } from "@/server/auth";
import { getProcurementStore, procurementEnabled } from "@/server/procurement";
import { handleGetRevision } from "@/server/procurement/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; revision: string }> }) {
  const { id, revision } = await params;
  return handleGetRevision(req, id, revision, getProcurementStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
