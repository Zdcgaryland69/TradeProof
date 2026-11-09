import { getAuthGate } from "@/server/auth";
import { approvalPaymentsEnabled, approvalPaymentsRefusedReason, getApprovalService } from "@/server/approval";
import { handlePaymentStep } from "@/server/approval/http";
import { procurementEnabled } from "@/server/procurement";

type Params = { params: Promise<{ id: string; approvalId: string }> };

// Refused unless approval payments are switched on by the server environment (payment-mode.ts).
export async function POST(req: Request, { params }: Params) {
  const { id, approvalId } = await params;
  return handlePaymentStep(req, id, approvalId, "reconcile", getApprovalService, { enabled: procurementEnabled(), auth: getAuthGate(), paymentsEnabled: approvalPaymentsEnabled(), paymentsRefusedReason: approvalPaymentsRefusedReason() });
}
