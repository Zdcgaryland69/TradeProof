// HTTP layer for the local procurement-draft API. Plain Web `Request`/`Response` (no Next.js
// imports), so it is unit-testable. Route files only wire these to `getProcurementStore()`.
//
//   GET  /api/procurements            list (summaries)
//   POST /api/procurements            create a DRAFT (+ optional source) → 201 | 422 field errors
//   GET  /api/procurements/:id        one request with items
//   PUT  /api/procurements/:id        { revision, ...fields }   → 200 | 409 CONFLICT (+ current) | 422
//        Every item sends `id` (an existing line id, or null for a new line). Items without the key →
//        422 CLIENT_OUTDATED (page loaded before schema v6): refresh, never "all lines are new".
//        Nothing differs from the stored record → 200 NO_CHANGES: nothing written, same revision.
//   GET  /api/procurements/:id/revisions             stored revision summaries (schema v8), newest first
//   GET  /api/procurements/:id/revisions/:revision   one stored revision with its full snapshot

import { MAX_BODY_BYTES, PROCUREMENT_SOURCES, type FieldError, type ProcurementSource } from "../../lib/procurement.ts";
import { canCreateRequest, canReadRequest, canWriteRequest, requestScope } from "../access/policy.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { PROCUREMENT_ID, type ProcurementStore } from "./store.ts";
import { OUTDATED_CLIENT_MESSAGE, validateProcurementInput } from "./validate.ts";

/** A store or a factory; a factory is only called after the guard passes (no DB opened otherwise). */
export type StoreSource = ProcurementStore | (() => ProcurementStore);

const LABEL = "Procurement API";

function resolve(source: StoreSource): ProcurementStore {
  return typeof source === "function" ? source() : source;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function notFound(): Response {
  return json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request." });
}

function invalid(errors: FieldError[]): Response {
  return json(422, { ok: false, code: "VALIDATION_FAILED", message: "Some fields need attention.", errors });
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Reads at most MAX_BODY_BYTES of UTF-8 JSON; stops reading as soon as the limit is passed. */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const fail = (status: number, code: string, message: string): BodyResult => ({ ok: false, response: json(status, { ok: false, code, message }) });
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return fail(415, "UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return fail(413, "PAYLOAD_TOO_LARGE", `Request body is larger than ${maxBytes} bytes.`);
  if (!req.body) return fail(400, "BAD_REQUEST", "Missing JSON body.");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return fail(413, "PAYLOAD_TOO_LARGE", `Request body is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(400, "BAD_REQUEST", "Body is not valid UTF-8.");
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return fail(400, "BAD_REQUEST", "Body is not valid JSON.");
  }
}

// GET /api/procurements
export async function handleList(req: Request, source: StoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  // Scope first (SQL), then order and LIMIT: only requests this account may read are listed or counted.
  return json(200, { ok: true, requests: resolve(source).list(100, requestScope(who, "r")) });
}

// POST /api/procurements — status, id, revision and timestamps are always set by the server.
// Optional `source` ("USER_INPUT" default | "DEMO_SAMPLE") is recorded once, for display only.
export async function handleCreate(req: Request, source: StoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!canCreateRequest(who)) return json(403, { ok: false, code: "FORBIDDEN", message: "Only a buyer account can create procurement requests." });
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    return invalid([{ field: "", message: "Body must be a JSON object." }]);
  }
  const { source: dataSource, ...fields } = body.value as Record<string, unknown>;
  const checked = validateProcurementInput(fields);
  const errors = checked.ok ? [] : [...checked.errors];
  if (dataSource !== undefined && !(PROCUREMENT_SOURCES as readonly unknown[]).includes(dataSource)) {
    errors.push({ field: "source", message: `Must be one of ${PROCUREMENT_SOURCES.join(", ")}.` });
  }
  if (!checked.ok || errors.length > 0) return invalid(errors);
  // The creating buyer becomes the owner in the same transaction; no client field can name another owner.
  const record = resolve(source).create(checked.value, (dataSource as ProcurementSource | undefined) ?? "USER_INPUT", who.id);
  return json(201, { ok: true, code: "CREATED", message: "Draft saved.", record });
}

// GET /api/procurements/:id
export async function handleGet(req: Request, id: string, source: StoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(id) || !canReadRequest(who, id)) return notFound();
  const record = resolve(source).get(id);
  return record ? json(200, { ok: true, record }) : notFound();
}

// PUT /api/procurements/:id — full replacement of the draft, only if `revision` is still current.
export async function handleUpdate(req: Request, id: string, source: StoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(id) || !canWriteRequest(who, id)) return notFound();
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    return invalid([{ field: "", message: "Body must be a JSON object." }]);
  }
  const { revision, ...fields } = body.value as Record<string, unknown>;
  const checked = validateProcurementInput(fields, "update");
  if (!checked.ok && checked.outdatedClient) {
    return json(422, { ok: false, code: "CLIENT_OUTDATED", message: OUTDATED_CLIENT_MESSAGE, errors: checked.errors });
  }
  const errors = checked.ok ? [] : [...checked.errors];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    errors.unshift({ field: "revision", message: "The revision you started editing from is required." });
  }
  if (!checked.ok || errors.length > 0) return invalid(errors);

  const outcome = resolve(source).update(id, revision as number, checked.value);
  if (outcome.status === "NOT_FOUND") return notFound();
  if (outcome.status === "INVALID_ITEMS") return invalid(outcome.errors);
  if (outcome.status === "NO_CHANGES") {
    return json(200, { ok: true, code: "NO_CHANGES", message: "No changes to save.", record: outcome.record });
  }
  if (outcome.status === "CONFLICT") {
    return json(409, {
      ok: false,
      code: "CONFLICT",
      message: `This request was changed elsewhere (now revision ${outcome.current.revision}). Nothing was overwritten.`,
      current: outcome.current,
    });
  }
  return json(200, { ok: true, code: "UPDATED", message: `Saved as revision ${outcome.record.revision}.`, record: outcome.record });
}

// GET /api/procurements/:id/revisions — same local guard and access check as the record itself.
export async function handleListRevisions(req: Request, id: string, source: StoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(id) || !canReadRequest(who, id)) return notFound();
  const store = resolve(source);
  if (!store.get(id)) return notFound();
  return json(200, { ok: true, revisions: store.revisions(id) });
}

// GET /api/procurements/:id/revisions/:revision — read-only; never creates or changes anything.
export async function handleGetRevision(req: Request, id: string, revisionText: string, source: StoreSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, LABEL);
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(id) || !/^[1-9][0-9]{0,8}$/.test(revisionText) || !canReadRequest(who, id)) return notFound();
  const entry = resolve(source).revision(id, Number(revisionText));
  return entry ? json(200, { ok: true, revision: entry }) : json(404, { ok: false, code: "NOT_FOUND", message: "This revision is not stored (history starts at the first recorded revision)." });
}
