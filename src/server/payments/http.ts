// HTTP layer for the local Sandbox demo API. Plain Web `Request`/`Response` (no Next.js imports),
// so it is unit-testable. Route files only wire these to `getPaymentService()`.

import { localOnlyGuard } from "../http/local-guard.ts";
import { formatMinorUnits } from "./money.ts";
import type { PaymentService, ResultCode, ServiceResult } from "./service.ts";
import type { PaymentRecord } from "./types.ts";

const RECORD_ID = /^tp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYPAL_ORDER_ID = /^[A-Z0-9]{5,36}$/;
const MAX_BODY_BYTES = 4096;

export const HTTP_STATUS: Record<ResultCode, number> = {
  RECORD_CREATED: 201,
  ORDER_READY: 200,
  PAID: 200,
  ALREADY_PAID: 200,
  NOT_FOUND: 404,
  NOT_CONFIGURED: 503,
  ORDER_MISMATCH: 409,
  NOT_READY: 409,
  NOT_APPROVED: 409,
  IN_PROGRESS: 409,
  CREATE_UNKNOWN: 202,
  CAPTURE_UNKNOWN: 202,
  CAPTURE_PENDING: 202,
  LOOKUP_FAILED: 502,
  NEEDS_REVIEW: 422,
  FAILED: 422,
  INVALID_STATE: 409,
  APPROVAL_INVALID: 409,
};

export interface DemoGuardOptions {
  enabled: boolean;
}

/** A service or a factory; a factory is only called after the guard passes (no DB opened otherwise). */
export type ServiceSource = PaymentService | (() => PaymentService);

function resolve(source: ServiceSource): PaymentService {
  return typeof source === "function" ? source() : source;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Local-only guard (see ../http/local-guard.ts): disabled outside development, loopback Host and Origin. */
export function guard(req: Request, opts: DemoGuardOptions): Response | null {
  return localOnlyGuard(req, opts, "Sandbox demo API");
}

/** Public view of a record. Contains no credentials (request ids are not secrets). */
export function recordView(record: PaymentRecord | null) {
  if (!record) return null;
  return {
    ...record,
    amount: `${record.currency} ${formatMinorUnits(record.amountMinor, record.currency)}`,
  };
}

function respond(result: ServiceResult): Response {
  return json(HTTP_STATUS[result.code], {
    ok: result.ok,
    code: result.code,
    message: result.message,
    orderId: result.orderId,
    problems: result.problems,
    record: recordView(result.record),
  });
}

function invalidId(): Response {
  return json(404, { ok: false, code: "NOT_FOUND", message: "Unknown local record." });
}

async function readSmallJson(req: Request): Promise<Record<string, unknown> | null | "invalid"> {
  const text = await req.text();
  if (text.length === 0) return null;
  if (text.length > MAX_BODY_BYTES) return "invalid";
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : "invalid";
  } catch {
    return "invalid";
  }
}

// POST /api/sandbox-demo/records — body is ignored on purpose: amount/currency are server-side only.
export async function handleCreateRecord(req: Request, source: ServiceSource, opts: DemoGuardOptions): Promise<Response> {
  const blocked = guard(req, opts);
  if (blocked) return blocked;
  return respond(resolve(source).createTestRecord());
}

// GET /api/sandbox-demo/records/:id
export async function handleGetRecord(req: Request, id: string, source: ServiceSource, opts: DemoGuardOptions): Promise<Response> {
  const blocked = guard(req, opts);
  if (blocked) return blocked;
  if (!RECORD_ID.test(id)) return invalidId();
  const service = resolve(source);
  const record = service.getRecord(id);
  if (!record) return invalidId();
  return json(200, { ok: true, record: recordView(record), events: service.events(id) });
}

// POST /api/sandbox-demo/records/:id/order — body ignored (no client amount, no client order id).
export async function handleCreateOrder(req: Request, id: string, source: ServiceSource, opts: DemoGuardOptions): Promise<Response> {
  const blocked = guard(req, opts);
  if (blocked) return blocked;
  if (!RECORD_ID.test(id)) return invalidId();
  return respond(await resolve(source).createPayPalOrder(id));
}

// POST /api/sandbox-demo/records/:id/capture — optional {orderId} is only cross-checked.
export async function handleCapture(req: Request, id: string, source: ServiceSource, opts: DemoGuardOptions): Promise<Response> {
  const blocked = guard(req, opts);
  if (blocked) return blocked;
  if (!RECORD_ID.test(id)) return invalidId();
  const body = await readSmallJson(req);
  if (body === "invalid") return json(400, { ok: false, code: "BAD_REQUEST", message: "Body must be a small JSON object." });
  let clientOrderId: string | undefined;
  if (body && "orderId" in body) {
    if (typeof body.orderId !== "string" || !PAYPAL_ORDER_ID.test(body.orderId)) {
      return json(400, { ok: false, code: "BAD_REQUEST", message: "orderId has an invalid format." });
    }
    clientOrderId = body.orderId;
  }
  return respond(await resolve(source).capture(id, clientOrderId));
}

// POST /api/sandbox-demo/records/:id/reconcile
export async function handleReconcile(req: Request, id: string, source: ServiceSource, opts: DemoGuardOptions): Promise<Response> {
  const blocked = guard(req, opts);
  if (blocked) return blocked;
  if (!RECORD_ID.test(id)) return invalidId();
  return respond(await resolve(source).reconcile(id));
}
