import { getAuthGate, getAuthService } from "@/server/auth";
import { handleLogout } from "@/server/auth/http";
import { procurementEnabled } from "@/server/procurement";

export async function POST(req: Request) {
  return handleLogout(req, getAuthService(), { enabled: procurementEnabled(), auth: getAuthGate() });
}
