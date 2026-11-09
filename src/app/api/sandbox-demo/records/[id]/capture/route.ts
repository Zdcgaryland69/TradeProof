import { getPaymentService, sandboxDemoEnabled } from "@/server/payments";
import { handleCapture } from "@/server/payments/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCapture(req, id, getPaymentService, { enabled: sandboxDemoEnabled() });
}
