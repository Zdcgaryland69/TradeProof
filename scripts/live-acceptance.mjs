// Real-model extraction acceptance, one SYNTHETIC case per invocation (manual run, never part of `npm test`).
//
//   npm run dev                                  (127.0.0.1:3000, with AI_* and AI_BUDGET_* / AI_PRICE_* set by the owner)
//   node scripts/live-acceptance.mjs LA-1        → creates the case's [SYNTHETIC / LIVE TEST] request and quote
//                                                  versions (first time only), checks the app reports LIVE + a
//                                                  configured budget, then makes ONE extraction request
//   node scripts/live-acceptance.mjs LA-1        (again) → re-sends the SAME run key: the server must replay,
//                                                  with no new model call and no new ledger row
//
// The run key is written to data/live-acceptance/state.json BEFORE the request, so an interrupted run is never
// sent twice by this script. Results go to data/live-acceptance/<case>.json (Git-ignored). Expected results:
// samples/synthetic/live-acceptance/expected.md. The API key is never read here; only the server uses it.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const CASES = join("samples", "synthetic", "live-acceptance");
const OUT = join("data", "live-acceptance");
const STATE = join(OUT, "state.json");
const caseId = process.argv[2];
const spec = JSON.parse(readFileSync(join(CASES, "cases.json"), "utf8")).cases.find((c) => c.id === caseId);
if (!spec) {
  console.error(`Usage: node scripts/live-acceptance.mjs <${["LA-1", "LA-2", "LA-3", "LA-4", "LA-5"].join("|")}>`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { cases: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", Origin: BASE }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const read = (f) => readFileSync(join(CASES, f), "utf8").replace(/\r\n/g, "\n");

// 1. Request and quote versions (local only; reused on later invocations).
let c = state.cases[caseId];
if (!c) {
  const created = await api("POST", "/api/procurements", { title: spec.title, buyerType: "BUSINESS", buyerCompany: "Synthetic buyer (live acceptance)", items: spec.items });
  if (created.status !== 201) throw new Error(`create request: ${created.status} ${JSON.stringify(created.data)}`);
  c = { requestId: created.data.record.id, seriesId: null, versionIds: [] };
  for (const [i, v] of spec.versions.entries()) {
    const fields = { rawText: read(v.file), contentKind: v.contentKind, source: "TEST_FIXTURE", sourceNote: `samples/synthetic/live-acceptance/${v.file}` };
    if (v.contentKind === "SUPPLEMENT") fields.supplementsVersionId = c.versionIds[v.supplements];
    const r =
      i === 0
        ? await api("POST", `/api/procurements/${c.requestId}/quotes`, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, name: `${spec.id} (SYNTHETIC)`, supplierDisplayName: "Fictional supplier", ...fields })
        : await api("POST", `/api/procurements/${c.requestId}/quotes/${c.seriesId}/versions`, { idempotencyKey: randomUUID(), expectedRequestRevision: 1, expectedLatestVersionId: c.versionIds.at(-1), ...fields });
    if (r.status !== 201) throw new Error(`save version ${i + 1}: ${r.status} ${JSON.stringify(r.data)}`);
    c.seriesId = r.data.series.id;
    c.versionIds.push(r.data.version.id);
  }
  state.cases[caseId] = c;
  save();
}
const versionId = c.versionIds[spec.extract];
const path = `/api/procurements/${c.requestId}/quotes/${c.seriesId}/versions/${versionId}/extractions`;

// 2. Pre-flight: the server must report the approved LIVE model and a configured budget; otherwise nothing is sent.
const before = await api("GET", path);
const cfg = before.data?.config;
if (cfg?.state !== "READY" || cfg.mode !== "LIVE" || cfg.provider !== "anthropic" || cfg.model !== "claude-sonnet-5-5") {
  console.error(`STOP: server config is ${JSON.stringify(cfg)} — expected READY / LIVE / anthropic / claude-sonnet-5-5. Nothing was sent.`);
  process.exit(1);
}
if (before.data.budget?.state !== "CONFIGURED") {
  console.error(`STOP: budget is ${before.data.budget?.state} (${JSON.stringify(before.data.budget?.missing ?? before.data.budget?.problems)}). Nothing was sent.`);
  process.exit(1);
}

// 3. One request. The key is stored first; a repeat invocation re-sends the same key (server replays).
const repeat = Boolean(c.runKey);
if (!c.runKey) {
  c.runKey = randomUUID();
  save();
}
const started = Date.now();
const res = await api("POST", path, { idempotencyKey: c.runKey, rerun: false });
const ms = Date.now() - started;
const after = await api("GET", path);
const run = res.data?.run ?? null;
if (run) {
  c.runId = run.id;
  save();
}
writeFileSync(join(OUT, `${caseId}${repeat ? ".repeat" : ""}.json`), JSON.stringify({ caseId, repeat, httpStatus: res.status, response: res.data, budget: after.data?.budget, costs: run ? after.data?.costs?.[run.id] : null, ms }, null, 2));

// 4. Compact summary for the person comparing with expected.md.
const f = (x) => (x ? `${x.check}${x.value !== null && x.value !== undefined ? ` = ${typeof x.value === "object" ? `${x.value.currency} ${x.value.amountText}` : x.value}` : ""}${x.check !== "SUPPORTED" && x.modelValue ? ` (model: ${x.modelValue})` : ""}` : "—");
console.log(`${caseId}${repeat ? " (repeat of the same key)" : ""}: HTTP ${res.status} ${res.data?.code ?? ""} in ${ms} ms`);
if (!run) {
  console.log(JSON.stringify(res.data));
  process.exit(0);
}
console.log(`run ${run.id} · ${run.mode} · ${run.provider}/${run.model} · ${run.status}${run.errorCode ? ` (${run.errorCode}: ${run.errorMessage})` : ""} · attempts ${run.attempts} · usage ${run.inputTokens} in / ${run.outputTokens} out · context ${run.contextVersionId ?? "—"}`);
for (const l of after.data?.costs?.[run.id] ?? []) console.log(`ledger attempt ${l.attempt}: ${l.state} reserved ${l.reservedMicros} settled ${l.settledMicros} ${l.currency} (${l.inputTokens}/${l.outputTokens} tokens) ${l.outcomeNote ?? ""}`);
const b = after.data?.budget;
if (b?.state === "CONFIGURED") console.log(`budget ${b.currency}: today settled ${b.today.settledMicros} pending ${b.today.pendingMicros} calls ${b.today.calls}/${b.limits.dailyCalls} · total settled ${b.total.settledMicros} pending ${b.total.pendingMicros} calls ${b.total.calls}/${b.limits.totalCalls} (micro-units)`);
const r = run.result;
if (r) {
  console.log(`checkRules ${r.checkRules} · numbers: ${r.supplierQuoteNumbers.map(f).join(" | ") || "none"}`);
  for (const k of ["quoteDate", "currency", "total", "incoterm", "leadTime", "paymentTerms"]) console.log(`  ${k}: ${f(r[k])}`);
  r.items.forEach((i, n) => console.log(`  item ${n + 1}: name ${f(i.name)} · qty ${f(i.quantity)} · unit ${f(i.unit)} · price ${f(i.unitPrice)} · match ${i.match.status} [${i.match.candidateIds.join(", ")}]${i.match.rejectedIds.length ? ` rejected ${i.match.rejectedIds.length}` : ""}`));
  r.fees.forEach((x, n) => console.log(`  fee ${n + 1}: kind ${f(x.kind)} · amount ${f(x.amount)} · basis ${f(x.amountBasis)} · payer ${f(x.payer)} · included ${f(x.includedInQuote)} · statedAs ${f(x.statedAs)}`));
  console.log(`  arithmetic: ${r.arithmetic.map((a) => a.code).join(", ")} · counts ${JSON.stringify(Object.fromEntries(Object.entries(r.counts).filter(([, v]) => v > 0)))}`);
}
