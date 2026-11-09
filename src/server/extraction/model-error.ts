// Errors from a model provider, shared by the call policy (model.ts) and the adapters (no imports, so no cycles).

export type ModelErrorCode = "NETWORK" | "RATE_LIMITED" | "SERVER_ERROR" | "AUTH" | "BAD_REQUEST" | "REFUSED" | "MOCK_NO_FIXTURE";

/**
 * An error from the provider. `retryable` only for errors where nothing was produced (connection, 429, 5xx).
 * `notSent` only when the adapter knows the request never left this machine (e.g. refused before
 * connecting); otherwise the budget treats the attempt as possibly billed.
 */
export class ModelCallError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly notSent: boolean;
  constructor(code: ModelErrorCode, retryable: boolean, message: string, notSent = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.notSent = notSent;
  }
}
