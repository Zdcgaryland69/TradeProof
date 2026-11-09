// HTTP layer for the Copilot (2 Nov). Local-only like every API; signed-in; CSRF on POST.
//
//   POST /api/procurements/:id/copilot         {intent, seriesId, versionId, runId, baseRunId, nonce} + Idempotency-Key
//   GET  /api/procurements/:id/copilot/basis   ?series=&version=[&run=][&baseRun=]   (no model call, no business write)
//
// The browser sends ids, one of five intents and a nonce — nothing else is accepted (no free text, no facts, links,
// amounts or roles). Not allowed and not existing give the same 404. Responses are never cached.

import { COPILOT_INTENTS, COPILOT_NONCE, type CopilotIntent } from "../../lib/copilot.ts";
import { IDEMPOTENCY_KEY, QUOTE_SERIES_ID, QUOTE_VERSION_ID } from "../../lib/quote-versions.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import { readCookie, SESSION_COOKIE } from "../auth/service.ts";
import { PROCUREMENT_ID } from "../procurement/store.ts";
import type { Selection } from "./facts.ts";
import { accountHash, type CopilotService } from "./service.ts";

export type CopilotSource = CopilotService | (() => CopilotService);
const resolve = (s: CopilotSource) => (typeof s === "function" ? s() : s);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json(404, { ok: false, code: "NOT_FOUND", message: "Unknown procurement request." });
const invalid = (message: string) => json(422, { ok: false, code: "VALIDATION_FAILED", message });
const RUN_ID = /^qx_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_KEYS = new Set(["intent", "seriesId", "versionId", "runId", "baseRunId", "nonce"]);

function selection(seriesId: unknown, versionId: unknown, runId: unknown, baseRunId: unknown): Selection | string {
  const opt = (v: unknown, re: RegExp, name: string): string | null | Error => (v === null || v === undefined || v === "" ? null : typeof v === "string" && re.test(v) ? v : new Error(name));
  const s = opt(seriesId, QUOTE_SERIES_ID, "seriesId");
  const v = opt(versionId, QUOTE_VERSION_ID, "versionId");
  const r = opt(runId, RUN_ID, "runId");
  const b = opt(baseRunId, RUN_ID, "baseRunId");
  for (const x of [s, v, r, b]) if (x instanceof Error) return `${x.message} must be an id or null.`;
  if ((s === null) !== (v === null)) return "seriesId and versionId go together.";
  return { seriesId: s as string | null, versionId: v as string | null, runId: r as string | null, baseRunId: b as string | null };
}

export async function handleAsk(req: Request, requestId: string, source: CopilotSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, "Copilot API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId)) return notFound();
  const key = req.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) return invalid("A request key (UUID) is required in the Idempotency-Key header.");
  const text = await req.text();
  if (text.length > 4096) return json(413, { ok: false, code: "TOO_LARGE", message: "Body too large." });
  let body: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return invalid("Body must be a JSON object.");
    body = v as Record<string, unknown>;
  } catch {
    return invalid("Body is not valid JSON.");
  }
  const unknown = Object.keys(body).filter((k) => !BODY_KEYS.has(k));
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}. The Copilot takes one of five questions and ids only — no free text, facts, links, amounts or roles.`);
  if (typeof body.intent !== "string" || !(COPILOT_INTENTS as readonly string[]).includes(body.intent)) return invalid(`intent must be one of ${COPILOT_INTENTS.join(", ")}.`);
  if (typeof body.nonce !== "string" || !COPILOT_NONCE.test(body.nonce)) return invalid("nonce must be 8–64 letters, digits or dashes.");
  const sel = selection(body.seriesId, body.versionId, body.runId, body.baseRunId);
  if (typeof sel === "string") return invalid(sel);
  const reauthorise = () => opts.auth.resolve(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  const out = await resolve(source).ask(who, requestId, sel, body.intent as CopilotIntent, key, body.nonce, reauthorise);
  switch (out.status) {
    case "NOT_FOUND":
      return notFound();
    case "UNAUTHENTICATED":
      return json(401, { ok: false, code: "UNAUTHENTICATED", message: "Sign in first." });
    case "KEY_REUSED":
      return json(409, { ok: false, code: "KEY_REUSED", message: "This request key was already used for another question or another state of the record. Press the button again." });
    case "OK":
      return json(200, { ok: true, answer: out.answer });
  }
}

export async function handleBasis(req: Request, requestId: string, source: CopilotSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, "Copilot API");
  if (who instanceof Response) return who;
  if (!PROCUREMENT_ID.test(requestId)) return notFound();
  const p = new URL(req.url).searchParams;
  const extra = [...p.keys()].filter((k) => !["series", "version", "run", "baseRun"].includes(k));
  if (extra.length > 0) return invalid(`Unknown parameter(s): ${extra.join(", ")}.`);
  const sel = selection(p.get("series"), p.get("version"), p.get("run"), p.get("baseRun"));
  if (typeof sel === "string") return invalid(sel);
  const svc = resolve(source);
  const out = svc.basis(who, requestId, sel);
  if (!out) return notFound();
  return json(200, { ok: true, basis: out.basis, resolved: out.resolved, account: accountHash(who.id), mode: svc.mode() });
}
