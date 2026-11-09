import { getPaymentService, sandboxDemoEnabled } from "@/server/payments";
import { handleReconcile } from "@/server/payments/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleReconcile(req, id, getPaymentService, { enabled: sandboxDemoEnabled() });
}
