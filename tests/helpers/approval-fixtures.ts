// SYNTHETIC approval cases (29 Oct) shared by tests/approval.test.ts and scripts/e2e/seed-approval.mjs.
// Quote texts: samples/synthetic/approval-quote-{a,b,c}.synthetic.md; hand-written MOCK outputs:
// samples/synthetic/approval-model-outputs.synthetic.json. The deposit case reuses the ORIGINAL, unchanged
// supplier-quote-en.synthetic.md + mock-model-output-en.synthetic.json (30 % deposit) as a blocked case.
// Runs are MOCK replays through a test double (no model, no token count, never the API budget).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionRun } from "../../src/lib/extraction.ts";
import type { Principal } from "../../src/server/access/policy.ts";
import { grantTestApprover, testApprover, testBuyer } from "./principals.ts";
import { emptyInput, type ProcurementInput, type ProcurementRecord } from "../../src/lib/procurement.ts";
import type { ExtractionModel, ModelReply, ResolvedModel } from "../../src/server/extraction/model.ts";
import { ExtractionService, reviewableFacts } from "../../src/server/extraction/service.ts";
import type { ExtractionStore } from "../../src/server/extraction/store.ts";
import type { ProcurementStore } from "../../src/server/procurement/store.ts";
import { validateProcurementInput } from "../../src/server/procurement/validate.ts";
import type { QuoteStore } from "../../src/server/quotes/store.ts";

const SAMPLES = join(process.cwd(), "samples", "synthetic");
const read = (f: string) => readFileSync(join(SAMPLES, f), "utf8");
const OUTPUTS = JSON.parse(read("approval-model-outputs.synthetic.json")) as Record<"A" | "B" | "C", unknown>;

export type CaseName = "A" | "B" | "C" | "DEPOSIT";
/** The buyer of the test DB (owns every request); approvals are made by the assigned test approver `A`. */
export const P: Principal = testBuyer();
export const A: Principal = testApprover();

export function caseText(name: CaseName): string {
  return name === "DEPOSIT" ? read("supplier-quote-en.synthetic.md") : read(`approval-quote-${name.toLowerCase()}.synthetic.md`);
}

/** Raw model output (JSON text) for a case, with request line ids filled in. */
export function caseOutput(name: CaseName, lines: { tumbler: string; box: string | null }): string {
  if (name === "DEPOSIT") {
    const o = JSON.parse(read("mock-model-output-en.synthetic.json")).output;
    o.items[0].requestItemCandidates = [lines.tumbler];
    return JSON.stringify(o);
  }
  return JSON.stringify(OUTPUTS[name]).split("{{LINE_TUMBLER}}").join(lines.tumbler).split("{{LINE_BOX}}").join(lines.box ?? "");
}

export function requestInput(name: CaseName, label: string, overrides: Partial<ProcurementInput> = {}): ProcurementInput {
  const base: ProcurementInput = {
    ...emptyInput(),
    buyerType: "BUSINESS",
    buyerCompany: "Test Co (SYNTHETIC)",
    title: `[TEST] approval ${label} (SYNTHETIC)`,
    shipFrom: "FOB Ningbo",
    budgetCurrency: "USD",
    budgetMax: "15.00",
    items:
      name === "DEPOSIT"
        ? [{ id: null, name: "Insulated bottle", quantity: "500", unit: "pcs", material: "", specification: "", customization: "", notes: "" }]
        : [
            { id: null, name: "Insulated tumbler 500 ml", quantity: "20", unit: "pcs", material: "304 stainless steel", specification: "", customization: "", notes: "" },
            { id: null, name: "Gift box", quantity: "20", unit: "pcs", material: "", specification: "", customization: "", notes: "" },
          ],
  };
  if (name === "DEPOSIT") base.budgetMax = "5000.00";
  return { ...base, ...overrides };
}

/** A replaying test double: returns whatever `next` holds. Labelled MOCK. */
export function replayModel(): ExtractionModel & { calls: number; next: string | null } {
  const m = {
    mode: "MOCK" as const,
    provider: "approval-replay",
    model: "synthetic-output",
    calls: 0,
    next: null as string | null,
    async complete(): Promise<ModelReply> {
      m.calls += 1;
      return { text: m.next!, truncated: false, inputTokens: null, outputTokens: null };
    },
  };
  return m;
}

export function replayService(es: ExtractionStore, model: ReturnType<typeof replayModel>, budget?: ConstructorParameters<typeof ExtractionService>[1]) {
  const resolveModel = (): ResolvedModel => ({ config: { state: "READY", mode: "MOCK", provider: model.provider, model: model.model }, model }) as ResolvedModel;
  return new ExtractionService(es, { resolveModel, nonce: () => "n", limits: { timeoutMs: 2000, maxAttempts: 1, retryDelayMs: 1 }, ...budget });
}

export interface Seeded {
  request: ProcurementRecord;
  seriesId: string;
  versionId: string;
  run: ExtractionRun;
  lines: { tumbler: string; box: string | null };
}

export interface SeedStores {
  ps: ProcurementStore;
  qs: QuoteStore;
  es: ExtractionStore;
  svc: ExtractionService;
  model: ReturnType<typeof replayModel>;
}

/** Request + quote v1 (text as given) + one MOCK replay run. Reviews are added separately. */
export async function seedCase(w: SeedStores, name: CaseName, label: string, opts: { text?: string; output?: (raw: string) => string; request?: Partial<ProcurementInput>; principal?: Principal; ownerId?: string | null; ownerSource?: "CREATED_BY_BUYER" | "OPERATOR_SEED" } = {}): Promise<Seeded> {
  const v = validateProcurementInput(requestInput(name, label, opts.request), "create");
  if (!v.ok) throw new Error(`request invalid: ${JSON.stringify(v.errors)}`);
  const request = w.ps.create(v.value, "USER_INPUT", opts.ownerId ?? null, opts.ownerSource);
  // Feature tests (test-double principals): the test approver gets a real GRANT row, which an approval now records.
  const path = (w as SeedStores & { path?: string }).path;
  if (!opts.principal && path) grantTestApprover(path, request.id);
  const lines = { tumbler: request.items[0].id, box: request.items[1]?.id ?? null };
  const saved = w.qs.createSeries(request.id, {
    idempotencyKey: randomUUID(),
    expectedRequestRevision: request.revision,
    name: `[TEST] approval ${label} quote (SYNTHETIC)`,
    supplierDisplayName: null,
    version: { rawText: opts.text ?? caseText(name), contentKind: "FULL_QUOTE", supplementsVersionId: null, source: "TEST_FIXTURE", sourceNote: `approval case ${name} (SYNTHETIC)`, supplierQuoteDate: null, revisionNote: null },
  });
  if (saved.status !== "CREATED") throw new Error(`quote not saved: ${saved.status}`);
  const raw = caseOutput(name, lines);
  w.model.next = opts.output ? opts.output(raw) : raw;
  const o = await w.svc.run(opts.principal ?? P, request.id, saved.series.id, saved.version.id, { idempotencyKey: randomUUID(), rerun: true });
  if (o.status !== "FINISHED") throw new Error(`run not finished: ${JSON.stringify(o)}`);
  return { request, seriesId: saved.series.id, versionId: saved.version.id, run: (o as { run: ExtractionRun }).run, lines };
}

/**
 * The user's review: item matches by name, then CONFIRM of every value the text supports, except `skip`;
 * `corrections` are entered as CORRECT with the given text instead.
 */
export function reviewAll(w: SeedStores, s: Seeded, opts: { skip?: (path: string) => boolean; corrections?: Record<string, string>; runId?: string; versionId?: string; seriesId?: string; principal?: Principal } = {}): number {
  const runId = opts.runId ?? s.run.id;
  const versionId = opts.versionId ?? s.versionId;
  const seriesId = opts.seriesId ?? s.seriesId;
  const run = w.es.getRun(runId)!;
  let n = 0;
  const latest = (path: string) => w.es.reviews(runId).filter((r) => r.fieldPath === path).at(-1)?.id ?? null;
  const add = (fieldPath: string, action: "CONFIRM" | "CORRECT" | "MATCH_ITEM", valueText: string | null, requestItemId: string | null) => {
    const out = w.svc.review(opts.principal ?? P, s.request.id, seriesId, versionId, runId, { idempotencyKey: randomUUID(), fieldPath, action, valueText, requestItemId, basedOnReviewId: latest(fieldPath) });
    if (out.status !== "CREATED") throw new Error(`review ${fieldPath} ${action}: ${JSON.stringify(out)}`);
    n += 1;
  };
  const record = w.ps.get(s.request.id)!;
  run.result!.items.forEach((it, i) => {
    const name = (it.name.value ?? it.name.modelValue ?? "").toLowerCase();
    const line = record.items.find((l) => name.includes(l.name.toLowerCase().split(" ")[0].toLowerCase())) ?? record.items[i];
    if (!opts.skip?.(`items[${i}].match`)) add(`items[${i}].match`, "MATCH_ITEM", null, line.id);
  });
  for (const [path, fact] of reviewableFacts(run.result!)) {
    if (path.endsWith(".match") || opts.skip?.(path)) continue;
    if (opts.corrections && path in opts.corrections) add(path, "CORRECT", opts.corrections[path], null);
    else if (fact && fact.check === "SUPPORTED") add(path, "CONFIRM", null, null);
  }
  return n;
}
