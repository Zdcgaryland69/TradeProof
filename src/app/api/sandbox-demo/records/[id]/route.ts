import { getPaymentService, sandboxDemoEnabled } from "@/server/payments";
import { handleGetRecord } from "@/server/payments/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleGetRecord(req, id, getPaymentService, { enabled: sandboxDemoEnabled() });
}
