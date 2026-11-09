import { getPaymentService, sandboxDemoEnabled } from "@/server/payments";
import { handleCreateOrder } from "@/server/payments/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCreateOrder(req, id, getPaymentService, { enabled: sandboxDemoEnabled() });
}
