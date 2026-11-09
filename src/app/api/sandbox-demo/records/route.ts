import { getPaymentService, sandboxDemoEnabled } from "@/server/payments";
import { handleCreateRecord } from "@/server/payments/http";

export async function POST(req: Request) {
  return handleCreateRecord(req, getPaymentService, { enabled: sandboxDemoEnabled() });
}
