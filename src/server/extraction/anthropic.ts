// Live adapter: Anthropic Claude API (official TypeScript SDK), approved 25 Oct 2026 for Claude Sonnet 5.5.
//
// One extraction attempt = exactly one HTTP request:
//   - SDK automatic retries are OFF (maxRetries: 0); the call policy (model.ts) never retries this adapter's
//     errors either, so one budget reservation can never turn into several paid requests;
//   - thinking: {type: "between_tools"} turns off up-front thinking on Sonnet 5.5 (no tools here, so the
//     reply is text only); thinking tokens would otherwise be billed as output. max_tokens (4,000) is a strict
//     cap on all generated output, so the output part of the reservation is a true upper bound;
//   - plain text output parsed strictly by check.ts (structured outputs are not used: the extraction schema
//     has far more nullable fields than its 16-union limit);
//   - no tools, no web search, no caching, no inference_geo, no refusal fallbacks (a fallback would run and
//     bill another model), no streaming.
// Input tokens for the reservation come from the official token counting endpoint (free; an estimate, so
// the budget adds a margin). The API key is passed explicitly, used only here, never logged or returned.
// Sources and check date: docs/quote-extraction.md "Live model (Anthropic)".

import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_LIMITS } from "../../lib/extraction.ts";
import { ModelCallError } from "./model-error.ts";
import type { ExtractionModel, ModelReply, ModelRequest } from "./model.ts";

/** Models the owner approved for real calls (25 Oct 2026). */
export const ANTHROPIC_APPROVED_MODELS = ["claude-sonnet-5-5"] as const;

/** The parts of the SDK client this adapter uses (tests pass a stub; nothing else is called). */
export interface AnthropicMessagesApi {
  create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; maxRetries?: number; timeout?: number }): Promise<Anthropic.Message>;
  countTokens(body: Anthropic.MessageCountTokensParams, options?: { maxRetries?: number; timeout?: number }): Promise<Anthropic.MessageTokensCount>;
}

const EFFORT = "high" as const; // between_tools is accepted only at effort high or below

function errorFor(err: unknown, phase: "count" | "call"): ModelCallError {
  // Never echo the error body verbatim (it could contain request details); status and type are enough.
  // Phase "count" generates nothing and is unbilled, so it is safe to report as "not sent" for the budget.
  const notSent = phase === "count";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelCallError("NETWORK", false, `Connection timed out (${phase}). Outcome unknown; not retried.`, notSent);
  if (err instanceof Anthropic.APIConnectionError) return new ModelCallError("NETWORK", false, `Network error (${phase}). Outcome unknown; not retried.`, notSent);
  if (err instanceof Anthropic.AuthenticationError) return new ModelCallError("AUTH", false, `HTTP 401 authentication_error (${phase}): check AI_API_KEY.`, notSent);
  if (err instanceof Anthropic.PermissionDeniedError) return new ModelCallError("AUTH", false, `HTTP 403 permission_error (${phase}).`, notSent);
  if (err instanceof Anthropic.RateLimitError) return new ModelCallError("RATE_LIMITED", false, `HTTP 429 rate_limit_error (${phase}). Not retried automatically.`, notSent);
  if (err instanceof Anthropic.BadRequestError) return new ModelCallError("BAD_REQUEST", false, `HTTP 400 invalid_request_error (${phase}).`, notSent);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    return new ModelCallError(status >= 500 ? "SERVER_ERROR" : "BAD_REQUEST", false, `HTTP ${status || "?"} (${phase}). Not retried automatically.`, notSent);
  }
  return new ModelCallError("SERVER_ERROR", false, `Unexpected ${phase} failure.`, notSent);
}

export class AnthropicExtractionModel implements ExtractionModel {
  readonly mode = "LIVE" as const;
  readonly provider = "anthropic";
  readonly model: string;
  private readonly api: AnthropicMessagesApi;

  constructor(model: string, apiKey: string, api?: AnthropicMessagesApi) {
    this.model = model;
    // Explicit key: never falls back to other credentials on this machine. SDK retries off.
    this.api = api ?? new Anthropic({ apiKey, maxRetries: 0, timeout: EXTRACTION_LIMITS.timeoutMs + 5_000 }).messages;
  }

  private body(request: Pick<ModelRequest, "system" | "user" | "maxOutputTokens">): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      thinking: { type: "between_tools" },
      output_config: { effort: EFFORT },
    };
  }

  async countInputTokens(request: Omit<ModelRequest, "signal" | "mockInput">): Promise<number> {
    const b = this.body(request);
    try {
      const r = await this.api.countTokens({ model: b.model, system: b.system, messages: b.messages, thinking: b.thinking, output_config: b.output_config }, { maxRetries: 0, timeout: 30_000 });
      if (!Number.isSafeInteger(r.input_tokens) || r.input_tokens <= 0) throw new ModelCallError("SERVER_ERROR", false, "Token count missing from the response.", true);
      return r.input_tokens;
    } catch (err) {
      throw err instanceof ModelCallError ? err : errorFor(err, "count");
    }
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    let res: Anthropic.Message & { _request_id?: string | null };
    try {
      res = await this.api.create(this.body(request), { signal: request.signal, maxRetries: 0, timeout: EXTRACTION_LIMITS.timeoutMs + 5_000 });
    } catch (err) {
      throw errorFor(err, "call");
    }
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const u = res.usage;
    const notes: string[] = [];
    if ((u.cache_creation_input_tokens ?? 0) > 0 || (u.cache_read_input_tokens ?? 0) > 0) notes.push("cache tokens reported (no cache prices configured)");
    if (u.inference_geo && u.inference_geo !== "global") notes.push(`inference region "${u.inference_geo}" (may be priced above the configured prices)`);
    if (u.service_tier && u.service_tier !== "standard") notes.push(`service tier "${u.service_tier}"`);
    if (res.model !== this.model) notes.push(`served by "${res.model}", not "${this.model}"`);
    return {
      text,
      truncated: res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded",
      inputTokens: Number.isSafeInteger(u.input_tokens) ? u.input_tokens : null,
      outputTokens: Number.isSafeInteger(u.output_tokens) ? u.output_tokens : null,
      stopReason: res.stop_reason ?? null,
      requestId: res._request_id ?? null,
      billingNote: notes.length > 0 ? `Usage cannot be priced exactly: ${notes.join("; ")}.` : null,
    };
  }
}
