import { getAuthGate } from "@/server/auth";
import { getProcurementStore, procurementEnabled } from "@/server/procurement";
import { handleCreate, handleList } from "@/server/procurement/http";

export async function GET(req: Request) {
  return handleList(req, getProcurementStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function POST(req: Request) {
  return handleCreate(req, getProcurementStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
