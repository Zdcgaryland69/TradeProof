import { getAuthGate } from "@/server/auth";
import { getProcurementStore, procurementEnabled } from "@/server/procurement";
import { handleGet, handleUpdate } from "@/server/procurement/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleGet(req, id, getProcurementStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleUpdate(req, id, getProcurementStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
