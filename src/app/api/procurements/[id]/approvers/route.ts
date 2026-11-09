import { getAuthGate, getAuthService } from "@/server/auth";
import { handleApprovers } from "@/server/auth/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string }> };

// Owner only: list approver accounts with their assignment state (GET), grant or revoke one (POST).
export async function GET(req: Request, { params }: Params) {
  return handleApprovers(req, (await params).id, getAuthService(), { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function POST(req: Request, { params }: Params) {
  return handleApprovers(req, (await params).id, getAuthService(), { enabled: procurementEnabled(), auth: getAuthGate() });
}
