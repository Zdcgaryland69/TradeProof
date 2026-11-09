// Comparison of a stored extraction run with the request snapshot of its quote version (26 Oct).
// Read-only and computed on demand: nothing is stored, no model is called, nothing is extracted. Every
// input is read here from the database — the version's text (hash recomputed), its request snapshot, the
// run and that run's reviews — never taken from the browser, which only names ids.

import { compareExtraction, runRefusal, type Comparison, type RunRefusal, type VersionFacts } from "../../lib/comparison.ts";
import { checkRulesOf, type ExtractionRun } from "../../lib/extraction.ts";
import { canReadRequest, type Principal } from "../access/policy.ts";
import { sha256, type ExtractionStore, type VersionInput } from "../extraction/store.ts";

export interface RunOption {
  id: string;
  mode: "LIVE" | "MOCK";
  provider: string;
  model: string;
  status: ExtractionRun["status"];
  startedAt: string;
  checkRules: string | null;
  /** null = can be compared; otherwise why not (the run can still be viewed in the extraction panel). */
  refusal: RunRefusal | "BASE_IS_SUPPLEMENT" | null;
}

export interface CompareChoices {
  version: { id: string; versionNumber: number; latestVersionNumber: number; contentKind: VersionInput["contentKind"]; rawTextSha256: string; requestRevision: number };
  currentRequestRevision: number | null;
  runs: RunOption[];
  /** SUPPLEMENT: the version it explicitly adds to, and that version's runs. */
  base: null | { versionId: string; versionNumber: number; contentKind: VersionInput["contentKind"]; runs: RunOption[] };
}

export type CompareRefusal = RunRefusal | "BASE_RUN_NOT_FOR_BASE_VERSION" | "BASE_RUN_NOT_USABLE" | "BASE_RUN_NOT_APPLICABLE";

export type CompareOutcome =
  | { status: "NOT_FOUND" }
  | { status: "CHOOSE"; choices: CompareChoices }
  | { status: "REFUSED"; code: CompareRefusal; choices: CompareChoices }
  | { status: "OK"; comparison: Comparison; choices: CompareChoices; rawText: string; baseRawText: string | null };

/** Singapore calendar day, as used by the budget and the lead-time check. */
export function singaporeDay(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function facts(input: VersionInput): VersionFacts {
  return {
    id: input.versionId,
    seriesId: input.seriesId,
    requestId: input.requestId,
    versionNumber: input.versionNumber,
    latestVersionNumber: input.latestVersionNumber,
    contentKind: input.contentKind,
    supplementsVersionId: input.context?.versionId ?? null,
    supplementsVersionNumber: input.context?.versionNumber ?? null,
    rawTextSha256: input.rawTextSha256,
    computedSha256: sha256(input.rawText),
    requestRevision: input.requestRevision,
    snapshot: input.snapshot,
  };
}

function option(run: ExtractionRun, version: VersionFacts, baseOfSupplement = false): RunOption {
  return {
    id: run.id,
    mode: run.mode,
    provider: run.provider,
    model: run.model,
    status: run.status,
    startedAt: run.startedAt,
    checkRules: run.result ? checkRulesOf(run.result) : null,
    refusal: baseOfSupplement && version.contentKind !== "FULL_QUOTE" ? "BASE_IS_SUPPLEMENT" : runRefusal(run, version),
  };
}

export class ComparisonService {
  private readonly store: ExtractionStore;
  private readonly now: () => Date;

  constructor(store: ExtractionStore, options: { now?: () => Date } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * `runId` null → only the choices (the page then names a run explicitly). A run of another request is
   * NOT_FOUND (it is not this request's data); a run of another version of the same request, a changed
   * text hash, a different snapshot revision, an unfinished run or older value-check rules → REFUSED.
   */
  compare(principal: Principal, requestId: string, seriesId: string, versionId: string, runId: string | null, baseRunId: string | null): CompareOutcome {
    if (!canReadRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const input = this.store.versionInput(requestId, seriesId, versionId);
    if (!input) return { status: "NOT_FOUND" };
    const version = facts(input);
    const baseInput = input.contentKind === "SUPPLEMENT" && input.context ? this.store.versionInput(requestId, seriesId, input.context.versionId) : null;
    const baseFacts = baseInput ? facts(baseInput) : null;
    const baseRuns = baseInput ? this.store.listRuns(baseInput.versionId) : [];
    const choices: CompareChoices = {
      version: { id: version.id, versionNumber: version.versionNumber, latestVersionNumber: version.latestVersionNumber, contentKind: version.contentKind, rawTextSha256: version.rawTextSha256, requestRevision: version.requestRevision },
      currentRequestRevision: this.store.currentRequestRevision(requestId),
      runs: this.store.listRuns(versionId).map((r) => option(r, version)),
      base: baseFacts ? { versionId: baseFacts.id, versionNumber: baseFacts.versionNumber, contentKind: baseFacts.contentKind, runs: baseRuns.map((r) => option(r, baseFacts, true)) } : null,
    };
    if (runId === null) return { status: "CHOOSE", choices };

    const run = this.store.getRun(runId);
    if (!run || run.requestId !== requestId) return { status: "NOT_FOUND" };
    const refusal = runRefusal(run, version);
    if (refusal) return { status: "REFUSED", code: refusal, choices };

    let baseRun: ExtractionRun | null = null;
    if (baseRunId !== null) {
      if (!baseFacts) return { status: "REFUSED", code: "BASE_RUN_NOT_APPLICABLE", choices };
      const candidate = this.store.getRun(baseRunId);
      if (!candidate || candidate.requestId !== requestId) return { status: "NOT_FOUND" };
      if (candidate.versionId !== baseFacts.id) return { status: "REFUSED", code: "BASE_RUN_NOT_FOR_BASE_VERSION", choices };
      if (option(candidate, baseFacts, true).refusal !== null) return { status: "REFUSED", code: "BASE_RUN_NOT_USABLE", choices };
      baseRun = candidate;
    }

    const comparison = compareExtraction({
      version,
      run,
      reviews: this.store.reviews(run.id),
      currentRequestRevision: choices.currentRequestRevision,
      base: baseFacts ? { version: baseFacts, run: baseRun, reviews: baseRun ? this.store.reviews(baseRun.id) : [] } : null,
      asOf: singaporeDay(this.now()),
    });
    return { status: "OK", comparison, choices, rawText: input.rawText, baseRawText: baseInput?.rawText ?? null };
  }
}
