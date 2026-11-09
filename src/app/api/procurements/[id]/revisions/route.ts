import { getAuthGate } from "@/server/auth";
import { getProcurementStore, procurementEnabled } from "@/server/procurement";
import { handleListRevisions } from "@/server/procurement/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleListRevisions(req, id, getProcurementStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
