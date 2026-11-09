import { getAuthService } from "@/server/auth";
import { handleLogin } from "@/server/auth/http";
import { procurementEnabled } from "@/server/procurement";

export async function POST(req: Request) {
  return handleLogin(req, getAuthService(), { enabled: procurementEnabled() });
}
