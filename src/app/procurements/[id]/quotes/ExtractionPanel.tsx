"use client";

// AI extraction for ONE saved quote version. Loading this panel only reads: a model call starts only
// when the user clicks Run (one click = one idempotency key; a retry after a network failure reuses it).
// The panel keeps three things apart: what the model said, what the text supports (checked by the
// server), and what the user confirmed. MOCK runs are labelled as such everywhere. Strings: src/i18n/en.ts.

import { csrfHeaders } from "@/lib/csrf-client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMicros, type BudgetAvailability, type LedgerState } from "@/lib/budget";
import type { ExtractionConfigState, ExtractionResult, ExtractionReview, ExtractionRun, Fact, FeeLine, SupplierRef } from "@/lib/extraction";
import { CURRENT_CHECK_RULES, FACT_CHECK_LABELS, checkRulesOf } from "@/lib/extraction";
import { shortItemRef } from "@/lib/procurement";
import type { QuoteVersion } from "@/lib/quote-versions";
import { en } from "@/i18n/en";
import { utc } from "./QuoteParts";

const t = en.extraction;

interface ListData {
  config: ExtractionConfigState;
  version: { id: string; versionNumber: number; latestVersionNumber: number; contentKind: string; rawTextSha256: string; requestRevision: number; snapshotItemIds: string[] };
  runs: ExtractionRun[];
  reviews: Record<string, ExtractionReview[]>;
  supplierRefs: SupplierRef[];
  budget: BudgetAvailability | null;
  costs: Record<string, CostLine[]>;
}

type CostLine = { attempt: number; state: LedgerState; currency: string; reservedMicros: number; settledMicros: number | null; inputTokens: number | null; outputTokens: number | null; outcomeNote: string | null };

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: ListData };
type Notice = { tone: "ok" | "warn" | "error"; text: string; rerunOffer?: boolean } | null;

const minor = (m: number) => `${Math.floor(m / 100).toLocaleString("en-US")}.${String(m % 100).padStart(2, "0")}`;

function display(path: string, value: unknown): string {
  if (value === null || value === undefined) return t.unknown;
  if (typeof value === "object" && value && "amountText" in value) {
    const m = value as { currency: string; amountText: string };
    return `${m.currency} ${m.amountText}`;
  }
  const key = path.split(".").pop() ?? "";
  const v = String(value);
  if (key === "kind") return (t.feeKinds as Record<string, string>)[v] ?? v;
  if (key === "payer" || key === "payee") return (t.parties as Record<string, string>)[v] ?? v;
  if (key === "includedInQuote") return (t.included as Record<string, string>)[v] ?? v;
  if (key === "statedAs") return (t.statedAs as Record<string, string>)[v] ?? v;
  if (key === "amountBasis") return t.basis[v] ?? v;
  return v;
}

function statusLabel(run: ExtractionRun): string {
  if (run.interrupted) return t.status.INTERRUPTED;
  return t.status[run.status];
}

function statusClass(run: ExtractionRun): string {
  if (run.status === "SUCCEEDED") return "pill"; // excerpts found ≠ verified: not shown in green
  if (run.status === "FAILED" || run.interrupted) return "pill s-FAILED";
  return "pill warn";
}

export default function ExtractionPanel({ requestId, seriesId, version }: { requestId: string; seriesId: string; version: QuoteVersion }) {
  const base = `/api/procurements/${requestId}/quotes/${seriesId}/versions/${version.id}/extractions`;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const pendingKey = useRef<{ key: string; rerun: boolean } | null>(null);

  const fetchList = useCallback(async (): Promise<Load> => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as (ListData & { message?: string }) | null;
      return res.ok && data?.runs ? { kind: "ready", data } : { kind: "error", message: data?.message ?? `HTTP ${res.status}` };
    } catch {
      return { kind: "error", message: en.editor.unreachable };
    }
  }, [base]);
  const refresh = useCallback(async () => setLoad(await fetchList()), [fetchList]);

  useEffect(() => {
    let live = true;
    void fetchList().then((next) => {
      if (live) setLoad(next);
    });
    return () => {
      live = false;
    };
  }, [fetchList]);

  // Another tab may have started a run: poll (read-only, no model call) while one is running here.
  const anyRunning = load.kind === "ready" && load.data.runs.some((r) => r.status === "RUNNING" && !r.interrupted);
  useEffect(() => {
    if (!anyRunning || busy) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [anyRunning, busy, refresh]);

  async function startRun(rerun: boolean) {
    if (load.kind !== "ready" || load.data.config.state !== "READY") return;
    const cfg = load.data.config;
    if (rerun && !window.confirm(t.rerunConfirm)) return;
    if (!rerun && cfg.mode === "LIVE" && !window.confirm(t.liveConfirm(cfg.provider, cfg.model))) return;
    // Same intent after a lost response → same key, so the server replays instead of calling again.
    if (!pendingKey.current || pendingKey.current.rerun !== rerun) pendingKey.current = { key: crypto.randomUUID(), rerun };
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(base, { method: "POST", headers: { ...csrfHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: pendingKey.current.key, rerun }), cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; message?: string; run?: ExtractionRun } | null;
      pendingKey.current = null; // a definite answer: the next click is a new intent
      if (data?.run) setSelectedRun(data.run.id);
      const tone: "ok" | "warn" | "error" = data?.ok ? (data.run?.status === "SUCCEEDED" ? "ok" : "warn") : res.status === 409 ? "warn" : "error";
      setNotice({ tone, text: data?.message ?? `HTTP ${res.status}`, rerunOffer: data?.code === "ALREADY_EXTRACTED" });
    } catch {
      // 8 Nov: the run may have started (the key is kept, so the same click again replays it). The run list is re-read below.
      setNotice({ tone: "error", text: t.runOutcomeUnknown });
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (load.kind === "loading") return <section className="card extraction" aria-label={t.heading}><h3>{t.heading}</h3><p className="muted">…</p></section>;
  if (load.kind === "error") {
    return (
      <section className="card extraction alert error-box" aria-label={t.heading}>
        <h3>{t.heading}</h3>
        <p role="alert">
          {t.loadFailed(load.message)}{" "}
          <button type="button" onClick={() => void refresh()}>
            {t.retryLoad}
          </button>
        </p>
      </section>
    );
  }

  const { config, runs, reviews, supplierRefs, version: v, budget, costs } = load.data;
  const shown = runs.find((r) => r.id === selectedRun) ?? runs.find((r) => r.result !== null) ?? runs[0] ?? null;
  const hasFinished = runs.some((r) => (r.status === "SUCCEEDED" || r.status === "INCOMPLETE") && config.state === "READY" && r.mode === config.mode && r.model === config.model);

  return (
    <section className="card extraction anchor-target" id="extraction" aria-label={t.heading} data-testid="extraction-panel">
      <h3>{t.heading}</h3>
      <p className="small muted">{t.scope(v.versionNumber, v.rawTextSha256.slice(0, 12), v.requestRevision)}</p>
      {v.latestVersionNumber > v.versionNumber ? (
        <p className="alert warn small" role="note">
          {t.newerVersion(v.versionNumber, v.latestVersionNumber)}
        </p>
      ) : null}
      {v.contentKind === "SUPPLEMENT" ? (
        <p className="alert warn small" role="note">
          {t.supplement}
        </p>
      ) : null}

      {config.state === "NOT_CONFIGURED" ? (
        <div className="alert warn" role="status" data-testid="extraction-not-configured">
          <strong>{t.notConfiguredTitle}</strong>
          <p className="small">{config.message}</p>
          {config.missing.length > 0 ? <p className="small">{t.missingVars(config.missing.join(", "))}</p> : null}
        </div>
      ) : config.mode === "MOCK" ? (
        <p className="sandbox-banner" role="note" data-testid="mock-banner">
          {t.mockBanner}
        </p>
      ) : (
        <p className="small">{t.liveModel(config.provider, config.model)}</p>
      )}
      <BudgetView budget={budget} mock={config.state === "READY" && config.mode === "MOCK"} />

      <div className="actions">
        <button type="button" className="primary" disabled={config.state !== "READY" || busy || anyRunning} onClick={() => void startRun(false)} data-testid="run-extraction">
          {busy || anyRunning ? t.running : config.state === "READY" && config.mode === "MOCK" ? t.runMock : t.run}
        </button>
        {hasFinished ? (
          <button type="button" disabled={busy || anyRunning} onClick={() => void startRun(true)}>
            {t.rerun}
          </button>
        ) : null}
      </div>
      <p className="hint">{t.notPaymentRule}</p>

      {notice ? (
        <p className={`card alert ${notice.tone === "ok" ? "ok-box" : notice.tone === "warn" ? "warn" : "error-box"}`} role={notice.tone === "error" ? "alert" : "status"} data-testid="extraction-notice">
          {notice.text}
        </p>
      ) : null}

      {runs.length === 0 ? (
        <p className="muted small">{t.noRuns}</p>
      ) : (
        <>
          <h4>{t.history}</h4>
          <ul className="run-list small">
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" className={`link-button neutral${shown?.id === r.id ? " selected" : ""}`} onClick={() => setSelectedRun(r.id)} data-run-status={r.status} data-run-button={r.id}>
                  {utc(r.startedAt)}
                </button>{" "}
                <span className={statusClass(r)}>{statusLabel(r)}</span> {r.mode === "MOCK" ? <span className="pill source-demo">MOCK</span> : <span className="pill" data-testid="live-pill">{t.livePill}</span>}{" "}
                <span className="muted">{t.runMeta(r.mode, r.provider, r.model, r.promptVersion, r.attempts)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {shown ? <RunView run={shown} costs={costs?.[shown.id] ?? []} reviews={reviews[shown.id] ?? []} supplierRefs={supplierRefs} version={version} base={base} onChanged={refresh} /> : null}
    </section>
  );
}

function BudgetView({ budget, mock }: { budget: BudgetAvailability | null; mock: boolean }) {
  const b = t.budget;
  if (!budget) return null;
  return (
    <p className="small budget" data-testid="api-budget" data-budget-state={budget.state}>
      {b.heading}: <strong>{budget.state === "AVAILABLE" ? b.available : b.unavailable(budget.reason ?? "")}</strong> · <span className="muted">{b.scope}</span>
      {mock ? <span className="muted"> {b.mockNote}</span> : null}
    </p>
  );
}

function RunView({
  run,
  costs,
  reviews,
  supplierRefs,
  version,
  base,
  onChanged,
}: {
  run: ExtractionRun;
  costs: CostLine[];
  reviews: ExtractionReview[];
  supplierRefs: SupplierRef[];
  version: QuoteVersion;
  base: string;
  onChanged: () => Promise<void>;
}) {
  const latest = (path: string) => [...reviews].reverse().find((r) => r.fieldPath === path) ?? null;
  const ctx = { run, base, latest, onChanged };
  return (
    <article className="run-view" data-run-id={run.id}>
      <p className="small">
        <span className={statusClass(run)}>{statusLabel(run)}</span>{" "}
        {run.mode === "MOCK" ? <span className="pill source-demo">MOCK — not an AI result</span> : <span className="pill" data-testid="live-run">{t.liveRunNote(run.provider, run.model)}</span>}{" "}
        {run.finishedAt ? utc(run.finishedAt) : ""} · {t.usage(run.inputTokens, run.outputTokens)} · {run.mode === "MOCK" ? t.budget.mockNote : t.costNote}
      </p>
      {costs.length > 0 ? (
        <ul className="small" data-testid="run-costs">
          {costs.map((c) => (
            <li key={c.attempt}>
              {c.state === "SETTLED"
                ? t.budget.runCost.SETTLED(c.attempt, c.currency, formatMicros(c.settledMicros ?? 0), c.inputTokens, c.outputTokens)
                : c.state === "RELEASED"
                  ? t.budget.runCost.RELEASED(c.attempt)
                  : t.budget.runCost[c.state](c.attempt, c.currency, formatMicros(c.reservedMicros))}
            </li>
          ))}
        </ul>
      ) : null}
      {run.status === "FAILED" ? (
        <p className="alert error-box small" role="alert" data-testid="run-failed">
          {t.failed(run.errorCode ?? "?", run.errorMessage ?? "")}
        </p>
      ) : null}
      {run.interrupted ? (
        <p className="alert error-box small" role="alert">
          {t.status.INTERRUPTED}
        </p>
      ) : null}
      {run.result && checkRulesOf(run.result) === CURRENT_CHECK_RULES && (run.status === "SUCCEEDED" || run.status === "INCOMPLETE") ? (
        <p className="small" data-testid="compare-run-link">
          <Link href={`/procurements/${run.requestId}/quotes/compare?series=${run.seriesId}&version=${run.versionId}&run=${run.id}`} prefetch={false}>
            {en.comparison.openLink}
          </Link>
        </p>
      ) : null}
      {run.result ? <ResultView result={run.result} ctx={ctx} supplierRefs={supplierRefs} version={version} /> : null}
      {run.rawOutput !== null ? (
        <details className="small">
          <summary>{t.rawOutput}</summary>
          <pre className="raw-output">{run.rawOutput}</pre>
        </details>
      ) : null}
    </article>
  );
}

type Ctx = { run: ExtractionRun; base: string; latest: (path: string) => ExtractionReview | null; onChanged: () => Promise<void>; legacyRules?: string | null };

function valueCheckLabel(fact: Fact<unknown>, legacyRules: string | null | undefined): string | null {
  if (fact.check !== "SUPPORTED" && !fact.valueCheck) return null; // the excerpt itself failed; nothing more to say
  if (fact.valueCheck) return t.valueCheck[fact.valueCheck.outcome](fact.valueCheck.rules);
  if (fact.kind === "INTERPRETED") return t.valueCheck.interpreted;
  return legacyRules ? t.valueCheck.legacy : null;
}

/**
 * 5 Nov: what this panel asks the user to review — every value row that shows "Pending your review" until reviewed (the
 * model gave a value) or already has a review, plus every item match. A count of the rows on screen, not an approval rule:
 * the approval preview still decides what is missing.
 */
function reviewTargets(result: ExtractionResult, latest: Ctx["latest"]): { total: number; done: number } {
  const facts: [string, Fact<unknown>][] = [
    ...result.supplierQuoteNumbers.map((f, i) => [`supplierQuoteNumbers[${i}]`, f] as [string, Fact<unknown>]),
    ...(["quoteDate", "currency", "total", "incoterm", "leadTime", "paymentTerms"] as const).map((k) => [k, result[k] as Fact<unknown>] as [string, Fact<unknown>]),
    ...result.items.flatMap((item, i) => (["name", "quantity", "unit", "material", "specification", "logo", "unitPrice"] as const).map((k) => [`items[${i}].${k}`, item[k] as Fact<unknown>] as [string, Fact<unknown>])),
    ...result.fees.flatMap((fee, i) => (Object.keys(t.feeLabels) as (keyof FeeLine)[]).map((k) => [`fees[${i}].${k}`, fee[k] as Fact<unknown>] as [string, Fact<unknown>])),
  ];
  let total = 0;
  let done = 0;
  for (const [path, fact] of facts) {
    const reviewed = latest(path) !== null;
    if (reviewed || fact.modelValue !== null) {
      total++;
      if (reviewed) done++;
    }
  }
  result.items.forEach((_, i) => {
    total++;
    if (latest(`items[${i}].match`)) done++;
  });
  return { total, done };
}

function ReviewProgress({ result, ctx }: { result: ExtractionResult; ctx: Ctx }) {
  const p = t.progress;
  const { total, done } = reviewTargets(result, ctx.latest);
  const last = useRef<Element | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  function next() {
    const root = bar.current?.closest(".run-view");
    if (!root) return;
    const rows = [...root.querySelectorAll("[data-pending-row]")];
    if (rows.length === 0) return;
    const prev = last.current && root.contains(last.current) ? last.current : null;
    const target = (prev ? rows.find((r) => prev.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) : null) ?? rows[0];
    last.current = target;
    target.scrollIntoView({ block: "center" });
    const focusable = target.querySelector<HTMLElement>("button, select, input");
    focusable?.focus({ preventScroll: true });
  }
  if (total === 0) return <p className="small muted review-progress">{p.none}</p>;
  return (
    <div className="review-progress" ref={bar} data-testid="review-progress" data-done={done} data-total={total}>
      <span role="status">
        <strong>{p.label(done, total)}</strong> <span className="muted small">{p.scope}</span>
      </span>
      <progress max={total} value={done} aria-hidden="true" />
      {done < total ? (
        <button type="button" onClick={next} data-testid="review-next">
          {p.next}
        </button>
      ) : (
        <span className="small" data-testid="review-all-done">
          ✓ {p.allDone}
        </span>
      )}
    </div>
  );
}

function ResultView({ result, ctx: baseCtx, supplierRefs, version }: { result: ExtractionResult; ctx: Ctx; supplierRefs: SupplierRef[]; version: QuoteVersion }) {
  const userRef = supplierRefs.filter((r) => r.origin !== "AI_CANDIDATE").at(-1) ?? null;
  const snapshotItems = version.requestSnapshot.record.items;
  const rules = checkRulesOf(result);
  // Results checked before 25 Oct keep the scope they actually had; they are never shown as re-checked.
  const ctx: Ctx = { ...baseCtx, legacyRules: rules === CURRENT_CHECK_RULES ? null : rules };
  return (
    <div className="result">
      <ReviewProgress result={result} ctx={ctx} />
      {ctx.legacyRules ? (
        <p className="alert warn small" role="note" data-testid="legacy-rules">
          {t.legacyRules(ctx.legacyRules, CURRENT_CHECK_RULES)}
        </p>
      ) : null}
      <details className="small legend">
        <summary>{t.legendTitle}</summary>
        <ul>
          {t.legend.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>

      <h4>{t.sections.numbers}</h4>
      <p className="small" data-testid="supplier-number">
        {userRef && userRef.valueRaw ? t.supplierNumber.current(userRef.valueRaw) : userRef?.origin === "USER_CLEARED" ? t.supplierNumber.cleared : t.supplierNumber.none}
      </p>
      {result.supplierQuoteNumbers.length === 0 ? <p className="muted small">{t.notStated}</p> : null}
      <dl className="facts">
        {result.supplierQuoteNumbers.map((f, i) => (
          <FactRow key={i} label={`#${i + 1}`} path={`supplierQuoteNumbers[${i}]`} fact={f} ctx={ctx} />
        ))}
      </dl>

      <h4>{t.sections.terms}</h4>
      <dl className="facts">
        {(["quoteDate", "currency", "total", "incoterm", "leadTime", "paymentTerms"] as const).map((key) => (
          <FactRow key={key} label={t.termLabels[key]} path={key} fact={result[key] as Fact<unknown>} ctx={ctx} />
        ))}
      </dl>

      <h4>{t.sections.items}</h4>
      {result.items.map((item, i) => (
        <div key={i} className="extracted-item">
          <MatchRow index={i} match={item.match} snapshotItems={snapshotItems} ctx={ctx} />
          <dl className="facts">
            {(["name", "quantity", "unit", "material", "specification", "logo", "unitPrice"] as const).map((key) => (
              <FactRow key={key} label={t.itemLabels[key]} path={`items[${i}].${key}`} fact={item[key] as Fact<unknown>} ctx={ctx} />
            ))}
          </dl>
        </div>
      ))}

      <h4>{t.sections.fees}</h4>
      {result.fees.length === 0 ? <p className="muted small">{t.noFees}</p> : null}
      {result.fees.map((fee, i) => (
        <div key={i} className="extracted-item">
          <dl className="facts">
            {(Object.keys(t.feeLabels) as (keyof FeeLine)[]).map((key) => (
              <FactRow key={key} label={t.feeLabels[key]} path={`fees[${i}].${key}`} fact={fee[key] as Fact<unknown>} ctx={ctx} />
            ))}
          </dl>
        </div>
      ))}

      <h4>{t.sections.checks}</h4>
      <ul className="small">
        {result.arithmetic.map((a, i) => (
          <li key={i} className={a.code === "TOTAL_ARITHMETIC_MISMATCH" ? "error" : undefined}>
            {a.message}
          </li>
        ))}
      </ul>

      <h4>{t.sections.summary}</h4>
      <ul className="small" data-testid="cost-summary">
        {result.costSummary.lines.map((l) => (
          <li key={l.currency}>
            {l.quotedTotalMinor === null ? t.summary.noQuoted(l.currency) : t.summary.quoted(l.currency, minor(l.quotedTotalMinor))}
            {l.extraKnownCount > 0 ? ` ${t.summary.extra(l.currency, minor(l.extraKnownMinor), l.extraKnownCount)}` : ""}
          </li>
        ))}
        {result.costSummary.unknownFeeCount > 0 ? <li className="unsaved">{t.summary.unknown(result.costSummary.unknownFeeCount)}</li> : null}
      </ul>
      <p className="hint">{t.summary.notPayment}</p>
    </div>
  );
}

async function postReview(ctx: Ctx, body: { fieldPath: string; action: string; valueText?: string; requestItemId?: string }): Promise<string | null> {
  const prior = ctx.latest(body.fieldPath);
  try {
    const res = await fetch(`${ctx.base}/${ctx.run.id}/reviews`, {
      method: "POST",
      headers: { ...csrfHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), basedOnReviewId: prior?.id ?? null, ...body }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    await ctx.onChanged();
    if (res.status === 409) return t.review.conflict;
    if (res.status >= 500 || (!res.ok && !data)) return OUTCOME_UNKNOWN;
    return res.ok ? null : t.review.failed(data?.message ?? `HTTP ${res.status}`);
  } catch {
    // 8 Nov: no usable answer — the review may be stored. Never "Not saved"; the row withholds its buttons until the
    // reviews have been re-read (read-only GET).
    return OUTCOME_UNKNOWN;
  }
}

/** Sentinel for a review whose outcome is unknown (network error or 5xx without a definite answer). */
const OUTCOME_UNKNOWN = "__OUTCOME_UNKNOWN__";

function UnknownOutcome({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "checking" | "failed">("idle");
  async function check() {
    setState("checking");
    try {
      await ctx.onChanged(); // GET of runs + reviews; writes nothing
      onDone();
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="small block" role="alert" data-testid="review-unknown">
      <span className="notice warn block">{state === "failed" ? en.editor.checkFailed : en.editor.outcomeUnknown}</span>
      <button type="button" className="link-button neutral" disabled={state === "checking"} onClick={() => void check()} data-testid="review-check-status">
        {state === "checking" ? en.editor.checking : en.editor.checkStatus}
      </button>
    </span>
  );
}

function FactRow({ label, path, fact, ctx }: { label: string; path: string; fact: Fact<unknown>; ctx: Ctx }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reopen, setReopen] = useState(false);
  const review = ctx.latest(path);
  const supported = fact.check === "SUPPORTED";
  const canReview = ctx.run.result !== null;
  const valueLabel = valueCheckLabel(fact, ctx.legacyRules);

  async function act(action: "CONFIRM" | "REJECT" | "CORRECT") {
    setSaving(true);
    const problem = await postReview(ctx, { fieldPath: path, action, ...(action === "CORRECT" ? { valueText: text } : {}) });
    setSaving(false);
    setError(problem);
    if (!problem) {
      setEditing(false);
      setReopen(false);
    }
  }
  const pending = !review && fact.modelValue !== null;
  const showActions = canReview && !editing && (!review || reopen) && error !== OUTCOME_UNKNOWN;
  // 7 Nov: a reviewed value whose excerpt supports it and whose value check found no problem collapses to one line
  // (value · review · Source · Review again). Pending, unsupported, not-stated, mismatched, reopened, editing or failed
  // rows keep the full block, so they stay easy to find. "Next to review" only targets pending rows (never collapsed).
  const clean = supported && (!fact.valueCheck || fact.valueCheck.outcome === "MATCH");
  const compact = !!review && clean && !reopen && !editing && !error;
  const [sourceOpen, setSourceOpen] = useState(false);
  const detailId = `src-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
  // The row re-renders in the other form when it is reopened or kept; keep keyboard focus inside the same row.
  // Compared with the previous value (not a "first render" flag): React's development double-run of effects would
  // otherwise move focus — and scroll — to a row on page load.
  const prevReopen = useRef(reopen);
  useEffect(() => {
    if (prevReopen.current === reopen) return;
    prevReopen.current = reopen;
    const row = document.querySelector(`[data-fact-path="${CSS.escape(path)}"]`);
    row?.querySelector<HTMLElement>(reopen ? ".review-actions button" : '[data-testid="review-again"]')?.focus();
  }, [reopen, path]);

  if (compact) {
    return (
      <>
        <dt>{label}</dt>
        <dd data-fact-path={path} data-check={fact.check} data-compact="" className="fact-compact">
          <span className="fact-line">
            <span className="fact-value">{display(path, fact.value)}</span>
            <span className="review small" data-review={review.action}>
              <span aria-hidden="true">✓ </span>
              {review.action === "CONFIRM" ? t.review.confirmed : review.action === "REJECT" ? t.review.rejected : t.review.corrected(review.valueText ?? "")} · {utc(review.createdAt)}
            </span>
            {fact.evidence ? <span className="small muted">{t.review.sourceLine(fact.evidence.line)}</span> : null}
            <span className="review-actions">
              <button type="button" className="link-button neutral" aria-expanded={sourceOpen} aria-controls={detailId} onClick={() => setSourceOpen((o) => !o)} data-testid="show-source">
                {sourceOpen ? t.review.hideSource : t.review.showSource}
              </button>
              {canReview ? (
                <button type="button" className="link-button neutral" onClick={() => setReopen(true)} data-testid="review-again">
                  {t.review.again}
                </button>
              ) : null}
            </span>
          </span>
          {sourceOpen ? (
            <span className="fact-detail small" id={detailId}>
              <span className={`pill check-${fact.check}`}>{FACT_CHECK_LABELS[fact.check]}</span>
              {fact.kind === "INTERPRETED" ? <span className="muted"> ({t.interpreted})</span> : null}
              {valueLabel ? (
                <span className="value-check" data-value-check={fact.valueCheck?.outcome ?? (ctx.legacyRules ? "LEGACY" : "NA")}>
                  {" "}
                  {valueLabel}
                </span>
              ) : null}
              {fact.note ? <span className="muted"> · {fact.note}</span> : null}
              {fact.evidence ? (
                <span className="excerpt">
                  <span className="muted">{t.excerptLine(fact.evidence.line, fact.evidence.occurrences)}:</span> <q className="pre">{fact.evidence.excerpt}</q>
                </span>
              ) : null}
            </span>
          ) : null}
        </dd>
      </>
    );
  }

  return (
    <>
      <dt>{label}</dt>
      <dd data-fact-path={path} data-check={fact.check} {...(pending ? { "data-pending-row": "" } : {})}>
        <span className={supported ? "" : "muted"}>{supported ? display(path, fact.value) : fact.check === "NOT_STATED" ? t.notStated : t.unknown}</span>{" "}
        <span className={`pill check-${fact.check}`}>{FACT_CHECK_LABELS[fact.check]}</span>
        {fact.kind === "INTERPRETED" && supported ? <span className="muted small"> ({t.interpreted})</span> : null}
        {!supported && fact.modelValue ? <span className="muted small"> · {t.modelSaid(display(path, fact.modelValue))}</span> : null}
        {valueLabel ? (
          <span className="small value-check" data-value-check={fact.valueCheck?.outcome ?? (ctx.legacyRules ? "LEGACY" : "NA")}>
            {valueLabel}
          </span>
        ) : null}
        {fact.note ? <span className="small muted"> · {fact.note}</span> : null}
        {fact.evidence ? (
          <span className="excerpt small">
            <span className="muted">{t.excerptLine(fact.evidence.line, fact.evidence.occurrences)}:</span> <q className="pre">{fact.evidence.excerpt}</q>
          </span>
        ) : null}
        {review ? (
          <span className="review small" data-review={review.action}>
            {review.action === "CONFIRM" ? t.review.confirmed : review.action === "REJECT" ? t.review.rejected : t.review.corrected(review.valueText ?? "")} ·{" "}
            {utc(review.createdAt)}
          </span>
        ) : fact.modelValue !== null ? (
          <span className="review small pending" data-review="PENDING">
            {t.reviewState.pending}
          </span>
        ) : null}
        {canReview && review && !reopen && !editing ? (
          <span className="review-actions">
            <button type="button" className="link-button neutral" onClick={() => setReopen(true)} data-testid="review-again">
              {t.review.again}
            </button>
          </span>
        ) : null}
        {reopen && !editing ? (
          <span className="small unsaved block" role="note">
            {t.review.againNote}
          </span>
        ) : null}
        {showActions ? (
          <span className="review-actions">
            {supported ? (
              <button type="button" className="link-button neutral" disabled={saving} onClick={() => void act("CONFIRM")}>
                {t.review.confirm}
              </button>
            ) : null}
            {fact.modelValue !== null ? (
              <button type="button" className="link-button" disabled={saving} onClick={() => void act("REJECT")}>
                {t.review.reject}
              </button>
            ) : null}
            <button type="button" className="link-button neutral" disabled={saving} onClick={() => setEditing(true)}>
              {t.review.correct}
            </button>
            {reopen ? (
              <button type="button" className="link-button neutral" onClick={() => setReopen(false)}>
                {t.review.keep}
              </button>
            ) : null}
          </span>
        ) : null}
        {editing ? (
          <span className="review-edit">
            <input type="text" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label={`${label}: ${t.review.correct}`} />
            <button type="button" disabled={saving || text.trim() === ""} onClick={() => void act("CORRECT")}>
              {t.review.saveCorrection}
            </button>
            <button
              type="button"
              className="link-button neutral"
              onClick={() => {
                setEditing(false);
                setReopen(false);
              }}
            >
              {t.review.cancel}
            </button>
          </span>
        ) : null}
        {error === OUTCOME_UNKNOWN ? (
          <UnknownOutcome ctx={ctx} onDone={() => setError(null)} />
        ) : error ? (
          <span className="error small" role="alert">
            {error}
          </span>
        ) : null}
      </dd>
    </>
  );
}

function MatchRow({ index, match, snapshotItems, ctx }: { index: number; match: ExtractionResult["items"][number]["match"]; snapshotItems: QuoteVersion["requestSnapshot"]["record"]["items"]; ctx: Ctx }) {
  const path = `items[${index}].match`;
  const review = ctx.latest(path);
  const [choice, setChoice] = useState(match.candidateIds.length === 1 ? match.candidateIds[0] : "");
  const [error, setError] = useState<string | null>(null);
  const [reopen, setReopen] = useState(false);
  const label = (id: string) => {
    const item = snapshotItems.find((i) => i.id === id);
    return `${shortItemRef(id)}${item ? ` — ${item.name}` : ""}`;
  };
  async function save(action: "MATCH_ITEM" | "NO_MATCH") {
    const problem = await postReview(ctx, { fieldPath: path, action, ...(action === "MATCH_ITEM" ? { requestItemId: choice } : {}) });
    setError(problem);
    if (!problem) setReopen(false);
  }
  return (
    <div className={`match match-${match.status}`} data-match-status={match.status} {...(!review ? { "data-pending-row": "" } : {})}>
      <strong className="small">
        {en.extraction.sections.items} #{index + 1}: {t.match[match.status]}
      </strong>
      {match.candidateIds.length > 0 ? <span className="small muted"> · {match.candidateIds.map(label).join(" / ")}</span> : null}
      {match.rejectedIds.length > 0 ? <span className="small error"> · {t.match.rejected(match.rejectedIds.length)}</span> : null}
      {review ? (
        <p className="small review" data-review={review.action}>
          {review.action === "MATCH_ITEM" && review.requestItemId ? t.match.confirmed(label(review.requestItemId)) : t.match.noMatch} · {utc(review.createdAt)}
        </p>
      ) : null}
      {review && !reopen ? (
        <p className="small review-actions">
          <button type="button" className="link-button neutral" onClick={() => setReopen(true)} data-testid="review-again">
            {t.review.again}
          </button>
        </p>
      ) : null}
      {review && reopen ? (
        <p className="small unsaved" role="note">
          {t.review.againNote}{" "}
          <button type="button" className="link-button neutral" onClick={() => setReopen(false)}>
            {t.review.keep}
          </button>
        </p>
      ) : null}
      {(!review || reopen) && error !== OUTCOME_UNKNOWN ? (
        <div className="review-edit">
        <label className="small">
          {t.match.chooseLabel}{" "}
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">—</option>
            {snapshotItems.map((i) => (
              <option key={i.id} value={i.id}>
                {label(i.id)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={choice === ""} onClick={() => void save("MATCH_ITEM")}>
          {t.match.choose}
        </button>
        <button type="button" className="link-button" onClick={() => void save("NO_MATCH")}>
          {t.match.none}
        </button>
        </div>
      ) : null}
      {error === OUTCOME_UNKNOWN ? (
        <p>
          <UnknownOutcome ctx={ctx} onDone={() => setError(null)} />
        </p>
      ) : error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
