// Bilingual clarification drafts (27 Oct). Every input is read on the server: the comparison is recomputed
// here from the stored version, run and reviews (ComparisonService, same ownership and refusal rules), and
// the questions are generated from it with paired templates. The browser names ids only, and on save sends
// its edited texts, which are kept apart from the generated ones and checked, never trusted as values.
// No model, no translation service, no PayPal call; nothing is sent to anyone.

import { checkDraft, generateDraft, initialContent, validateContent, type DraftCheck, type DraftContent, type GeneratedDraft } from "../../lib/clarification.ts";
import type { Comparison } from "../../lib/comparison.ts";
import { canReadRequest, canWriteRequest, type Principal } from "../access/policy.ts";
import type { CompareRefusal, ComparisonService } from "../comparison/service.ts";
import { sha256, type ClarificationStore, type DraftRevision, type DraftSource, type DraftSummary, type StoredDraft } from "./store.ts";

export type BasisChange =
  | "REQUEST_REVISED"
  | "NEWER_QUOTE_VERSION"
  | "REVIEWS_CHANGED"
  | "NEWER_RUN"
  | "QUESTIONS_CHANGED"
  | "TEMPLATE_CHANGED"
  | "BASIS_NOT_USABLE";

export interface BasisStatus {
  /** Empty = the stored records still give the same questions from the same basis. */
  changes: BasisChange[];
  currentRequestRevision: number | null;
  latestVersionNumber: number | null;
  newerRunId: string | null;
  /** Why the run cannot be compared any more (BASIS_NOT_USABLE). */
  refusal: CompareRefusal | "NOT_FOUND" | null;
}

export interface DraftView {
  draft: StoredDraft;
  initial: DraftRevision;
  latest: DraftRevision;
  revisionCount: number;
  basis: BasisStatus;
  successors: string[];
  /** Check of the latest saved content (the page re-runs it on every edit before showing a result). */
  check: DraftCheck;
}

export type CreateResult =
  | { status: "NOT_FOUND" }
  | { status: "REFUSED"; code: CompareRefusal }
  | { status: "CREATED" | "EXISTING"; draft: StoredDraft };

export type SaveResult =
  | { status: "NOT_FOUND" }
  | { status: "INVALID"; message: string }
  | { status: "KEY_REUSED" }
  | { status: "CONFLICT"; current: DraftRevision }
  | { status: "SAVED" | "UNCHANGED" | "REPLAYED"; revision: DraftRevision; check: DraftCheck };

function questionsDigest(g: GeneratedDraft): string {
  return sha256(JSON.stringify([g.templateVersion, g.questions.map((q) => [q.id, q.audience, q.en, q.zh]), g.buyerChecks.map((b) => b.id)])).slice(0, 32);
}

export class ClarificationService {
  private readonly store: ClarificationStore;
  private readonly comparison: ComparisonService;

  constructor(store: ClarificationStore, comparison: ComparisonService) {
    this.store = store;
    this.comparison = comparison;
  }

  private source(c: Comparison, g: GeneratedDraft, seriesId: string): DraftSource {
    const b = c.binding;
    const reviews = [this.store.reviewState(b.run.id), ...(b.base?.run ? [this.store.reviewState(b.base.run.id)] : [])];
    return {
      requestId: b.requestId,
      seriesId,
      versionId: b.version.id,
      versionNumber: b.version.versionNumber,
      latestVersionNumber: b.version.latestVersionNumber,
      contentKind: b.version.contentKind,
      rawTextSha256: b.version.rawTextSha256,
      snapshotRevision: b.snapshotRevision,
      currentRequestRevision: b.currentRequestRevision,
      run: { id: b.run.id, mode: b.run.mode, provider: b.run.provider, model: b.run.model, checkRules: b.run.checkRules, startedAt: b.run.startedAt },
      baseRun: b.base?.run ? { id: b.base.run.id, versionId: b.base.versionId, versionNumber: b.base.versionNumber } : null,
      reviews,
      comparatorVersion: b.comparatorVersion,
      asOf: b.asOf,
      questionsDigest: questionsDigest(g),
    };
  }

  private static fingerprint(s: DraftSource, templateVersion: string): string {
    return sha256(
      JSON.stringify([s.versionId, s.rawTextSha256, s.snapshotRevision, s.currentRequestRevision, s.latestVersionNumber, s.run.id, s.baseRun?.id ?? null, s.reviews, s.comparatorVersion, templateVersion, s.questionsDigest]),
    );
  }

  /**
   * Generates a draft from the comparison of this run (and base run) as stored now. The same basis returns the
   * existing draft (EXISTING): repeated clicks, refreshes or a second tab never create a second one.
   * `supersedesId` (explicit regeneration) must be a draft of the same request, series and version.
   */
  create(principal: Principal, requestId: string, seriesId: string, versionId: string, runId: string, baseRunId: string | null, supersedesId: string | null): CreateResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    if (supersedesId !== null) {
      const prev = this.store.get(supersedesId);
      if (!prev || prev.requestId !== requestId || prev.seriesId !== seriesId || prev.versionId !== versionId) return { status: "NOT_FOUND" };
    }
    const outcome = this.comparison.compare(principal, requestId, seriesId, versionId, runId, baseRunId);
    if (outcome.status === "NOT_FOUND" || outcome.status === "CHOOSE") return { status: "NOT_FOUND" };
    if (outcome.status === "REFUSED") return { status: "REFUSED", code: outcome.code };
    const generated = generateDraft(outcome.comparison);
    const source = this.source(outcome.comparison, generated, seriesId);
    return this.store.create({ source, fingerprint: ClarificationService.fingerprint(source, generated.templateVersion), generated, initial: initialContent(generated), supersedesId });
  }

  private basis(principal: Principal, d: StoredDraft): BasisStatus {
    const s = d.source;
    const outcome = this.comparison.compare(principal, d.requestId, d.seriesId, d.versionId, d.extractionId, d.baseExtractionId);
    const changes: BasisChange[] = [];
    if (outcome.status !== "OK") {
      const refusal = outcome.status === "REFUSED" ? outcome.code : "NOT_FOUND";
      return { changes: ["BASIS_NOT_USABLE"], currentRequestRevision: null, latestVersionNumber: null, newerRunId: null, refusal };
    }
    const c = outcome.comparison;
    if (c.binding.currentRequestRevision !== s.currentRequestRevision) changes.push("REQUEST_REVISED");
    if (c.binding.version.latestVersionNumber !== s.latestVersionNumber) changes.push("NEWER_QUOTE_VERSION");
    const reviewsNow = [this.store.reviewState(s.run.id), ...(s.baseRun ? [this.store.reviewState(s.baseRun.id)] : [])];
    if (JSON.stringify(reviewsNow) !== JSON.stringify(s.reviews)) changes.push("REVIEWS_CHANGED");
    const newer = outcome.choices.runs.find((r) => r.refusal === null && r.id !== s.run.id && r.startedAt > s.run.startedAt) ?? null;
    if (newer) changes.push("NEWER_RUN");
    const regenerated = generateDraft(c);
    if (regenerated.templateVersion !== d.templateVersion) changes.push("TEMPLATE_CHANGED");
    else if (questionsDigest(regenerated) !== s.questionsDigest) changes.push("QUESTIONS_CHANGED");
    return { changes, currentRequestRevision: c.binding.currentRequestRevision, latestVersionNumber: c.binding.version.latestVersionNumber, newerRunId: newer?.id ?? null, refusal: null };
  }

  /** Opening a draft reads only. A draft of another request is NOT_FOUND (same answer as an unknown id). */
  open(principal: Principal, requestId: string, draftId: string): DraftView | null {
    if (!canReadRequest(principal, requestId)) return null;
    const draft = this.store.get(draftId);
    if (!draft || draft.requestId !== requestId) return null;
    const revisions = this.store.revisions(draftId);
    const initial = revisions[0];
    const latest = revisions[revisions.length - 1];
    return {
      draft,
      initial,
      latest,
      revisionCount: revisions.length,
      basis: this.basis(principal, draft),
      successors: this.store.successors(draftId),
      check: checkDraft(latest.content, initial.content),
    };
  }

  save(principal: Principal, requestId: string, draftId: string, expectedRevision: number, content: unknown, saveKey: string): SaveResult {
    if (!canWriteRequest(principal, requestId)) return { status: "NOT_FOUND" };
    const draft = this.store.get(draftId);
    if (!draft || draft.requestId !== requestId) return { status: "NOT_FOUND" };
    const valid = validateContent(content, draft.generated);
    if (!valid.ok) return { status: "INVALID", message: valid.message };
    const saved = this.store.save(draftId, expectedRevision, valid.content, saveKey);
    if (saved.status === "KEY_REUSED" || saved.status === "CONFLICT") return saved;
    const initial = this.store.revisions(draftId)[0];
    return { ...saved, check: checkDraft(saved.revision.content, initial.content as DraftContent) };
  }

  /** Drafts of one quote version (newest first), only if request → series → version belong together. */
  list(principal: Principal, requestId: string, seriesId: string, versionId: string): DraftSummary[] | null {
    if (!canReadRequest(principal, requestId)) return null;
    const outcome = this.comparison.compare(principal, requestId, seriesId, versionId, null, null);
    if (outcome.status === "NOT_FOUND") return null;
    return this.store.listForVersion(versionId);
  }
}
