"use client";

// Copilot panel (2 Nov; docs/copilot-plan.md §3–§4). Five fixed questions about THIS record and the quote version
// selected on the page; no free text. Every answer shows TradeProof's own facts (not AI) and, when it passed the
// server's checks, an explanation labelled LIVE (provider/model) or MOCK (canned test output, not AI).
// Answers live only in this component's state (no localStorage / sessionStorage): a reload starts empty. A response is
// dropped unless it belongs to the latest click, this account, this record and this version. On focus / visibility /
// "Check now" the panel re-reads the basis (no model call): signed out or no access → the answer is cleared; another
// account → cleared; a changed basis → marked outdated. An answer already seen or copied cannot be taken back.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BASIS_PART_LABELS,
  COPILOT_INTENTS,
  COPILOT_QUESTIONS,
  EXPLANATION_REASON_LABELS,
  changedParts,
  type BasisPart,
  type CopilotAnswer,
  type CopilotBasis,
  type CopilotIntent,
} from "@/lib/copilot";
import { csrfHeaders } from "@/lib/csrf-client";

export const COPILOT_SIGNOUT_EVENT = "tradeproof:signing-out";

type Mode = { kind: "LIVE" | "MOCK" | "NONE"; reason: string | null };
type Gone = "SIGNED_OUT" | "NO_ACCESS" | "OTHER_ACCOUNT" | null;

const GONE_TEXT: Record<Exclude<Gone, null>, string> = {
  SIGNED_OUT: "You are signed out. The answer was cleared.",
  NO_ACCESS: "You can no longer view this record. The answer was cleared.",
  OTHER_ACCOUNT: "Another account is signed in now. The answer was cleared.",
};

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export default function CopilotPanel({ requestId, seriesId, versionId }: { requestId: string; seriesId: string; versionId: string }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [current, setCurrent] = useState<CopilotBasis | null>(null);
  const [answer, setAnswer] = useState<CopilotAnswer | null>(null);
  const [busy, setBusy] = useState<CopilotIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<Gone>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  const accountRef = useRef<string | null>(null);
  const live = useRef(true);
  const sending = useRef(false);

  const clear = useCallback((why: Gone) => {
    latest.current = null;
    setAnswer(null);
    setBusy(null);
    setGone(why);
  }, []);

  const check = useCallback(async () => {
    const q = new URLSearchParams({ series: seriesId, version: versionId });
    let res: Response;
    try {
      res = await fetch(`/api/procurements/${requestId}/copilot/basis?${q}`, { cache: "no-store" });
    } catch {
      if (live.current) setError("Could not reach the local server to check the answer.");
      return;
    }
    if (!live.current) return;
    if (res.status === 401) return clear("SIGNED_OUT");
    if (res.status === 404) return clear("NO_ACCESS");
    const data = (await res.json().catch(() => null)) as { basis?: CopilotBasis; account?: string; mode?: Mode } | null;
    if (!live.current || !data?.basis || !data.account) return;
    if (accountRef.current && accountRef.current !== data.account) clear("OTHER_ACCOUNT");
    accountRef.current = data.account;
    setAccount(data.account);
    setCurrent(data.basis);
    setMode(data.mode ?? null);
    setCheckedAt(new Date().toISOString().slice(11, 19));
    setError(null);
  }, [requestId, seriesId, versionId, clear]);

  useEffect(() => {
    live.current = true;
    // First check as a callback (subscribe-then-read): state is only set when the basis response arrives.
    const first = setTimeout(() => void check(), 0);
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onSignOut = () => clear("SIGNED_OUT");
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(COPILOT_SIGNOUT_EVENT, onSignOut);
    return () => {
      clearTimeout(first);
      live.current = false;
      latest.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(COPILOT_SIGNOUT_EVENT, onSignOut);
    };
  }, [check, clear]);

  async function ask(intent: CopilotIntent) {
    // Synchronous guard: React state is not updated between two clicks in the same tick, and each click would carry
    // its own request key (= a second paid call in LIVE). Found by copilot.e2e (2 Nov): double click sent two POSTs.
    if (sending.current) return;
    sending.current = true;
    try {
      await send(intent);
    } finally {
      sending.current = false;
    }
  }

  async function send(intent: CopilotIntent) {
    const nonce = newId();
    latest.current = nonce;
    setBusy(intent);
    setError(null);
    setGone(null);
    setAnswer(null);
    let res: Response;
    try {
      res = await fetch(`/api/procurements/${requestId}/copilot`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newId(), ...csrfHeaders() },
        body: JSON.stringify({ intent, seriesId, versionId, runId: null, baseRunId: null, nonce }),
      });
    } catch {
      if (live.current && latest.current === nonce) {
        setBusy(null);
        setError("Could not reach the local server. Nothing is shown; press the button again to ask again.");
      }
      return;
    }
    if (!live.current || latest.current !== nonce) return; // late response for an older click / another view
    if (res.status === 401) return clear("SIGNED_OUT");
    if (res.status === 404) return clear("NO_ACCESS");
    const data = (await res.json().catch(() => null)) as { answer?: CopilotAnswer; message?: string } | null;
    if (!live.current || latest.current !== nonce) return;
    setBusy(null);
    const a = data?.answer;
    if (!res.ok || !a) {
      setError(data?.message ?? `HTTP ${res.status}`);
      return;
    }
    // Drop anything that is not for this click, this account, this record and this version.
    if (a.answerFor.nonce !== nonce || a.answerFor.requestId !== requestId || a.answerFor.versionId !== versionId || (accountRef.current && a.answerFor.account !== accountRef.current)) return;
    accountRef.current = a.answerFor.account;
    setAccount(a.answerFor.account);
    setAnswer(a);
    setCurrent(a.basis);
  }

  const outdated: BasisPart[] = answer ? [...new Set([...answer.changed, ...(current ? changedParts(answer.basis, current) : [])])] : [];
  const isOutdated = !!answer && (answer.status === "OUTDATED" || outdated.length > 0);
  const modeText =
    mode === null ? "Checking…" : mode.kind === "LIVE" ? "AI explanations: on (real model; uses the shared AI budget)" : mode.kind === "MOCK" ? "MOCK mode — canned test output, not AI" : `No AI explanation — ${EXPLANATION_REASON_LABELS[mode.reason as keyof typeof EXPLANATION_REASON_LABELS] ?? mode.reason}`;
  const factById = new Map(answer?.facts.map((f) => [f.id, f]) ?? []);
  const linkById = new Map(answer?.links.map((l) => [l.id, l]) ?? []);
  const anchor = (id: string) => `copilot-${id}`;

  return (
    <section className="card copilot" data-testid="copilot-panel" data-account={account ?? ""} data-mode={mode?.kind ?? ""} aria-label="Copilot">
      <h3>Copilot (English)</h3>
      <p className="small muted">
        Explains TradeProof&apos;s own facts about this record and quote version. It cannot change, confirm, approve, pay or send anything. Five fixed questions; no free text.
      </p>
      <p className="small" data-testid="copilot-mode">
        <span className={`pill${mode?.kind === "LIVE" ? "" : " warn"}`}>{modeText}</span>
      </p>
      <div className="copilot-buttons">
        {COPILOT_INTENTS.map((intent) => (
          <button key={intent} type="button" onClick={() => void ask(intent)} disabled={busy !== null} data-testid={`copilot-ask-${intent}`} aria-busy={busy === intent}>
            {busy === intent ? "Asking…" : COPILOT_QUESTIONS[intent]}
          </button>
        ))}
      </div>
      <p className="small muted">
        <button type="button" onClick={() => void check()} data-testid="copilot-check">
          Check now
        </button>{" "}
        {checkedAt ? `Last checked ${checkedAt} UTC (access and basis; no AI call).` : null}
      </p>
      {gone ? (
        <p className="alert warn small" role="status" data-testid="copilot-gone" data-gone={gone}>
          {GONE_TEXT[gone]}
        </p>
      ) : null}
      {error ? (
        <p className="alert error-box small" role="alert" data-testid="copilot-error">
          {error}
        </p>
      ) : null}
      {answer ? (
        <div data-testid="copilot-answer" data-intent={answer.intent} data-status={isOutdated ? "OUTDATED" : "CURRENT"} data-explanation={answer.explanation.kind}>
          <h4>{answer.question}</h4>
          {isOutdated ? (
            <p className="alert warn small" data-testid="copilot-outdated">
              Based on an earlier state ({outdated.map((p) => BASIS_PART_LABELS[p]).join("; ") || "the record changed"}). This is not the current answer. Ask again to refresh.
            </p>
          ) : (
            <p className="small muted" data-testid="copilot-current">
              Current for this record and quote version as of the last check.
            </p>
          )}
          {answer.repeat ? <p className="small muted">This click was already answered; showing the first result (no second AI call).</p> : null}

          <div className="copilot-explanation" data-testid="copilot-explanation">
            {answer.explanation.kind === "NONE" ? (
              <p className="small" data-testid="copilot-no-explanation" data-reason={answer.explanation.reason}>
                <strong>No AI explanation.</strong> {EXPLANATION_REASON_LABELS[answer.explanation.reason]}
                {answer.explanation.detail ? <span className="muted"> ({answer.explanation.detail})</span> : null} The facts below are complete.
              </p>
            ) : (
              <>
                <p className="small">
                  <span className={`pill${answer.explanation.kind === "MOCK" ? " warn" : ""}`} data-testid="copilot-explanation-label">
                    {answer.explanation.kind === "MOCK" ? "MOCK — canned test output, not AI" : `AI explanation · ${answer.explanation.provider} ${answer.explanation.model} · checked against the facts below`}
                  </span>
                </p>
                <ul data-testid="copilot-sentences">
                  {answer.explanation.sentences.map((s, i) => (
                    <li key={i}>
                      {s.text}{" "}
                      {s.facts.map((id) => (
                        <a key={id} href={`#${anchor(id)}`} className="small" title={factById.get(id)?.text.slice(0, 200)}>
                          [{id}]
                        </a>
                      ))}
                    </li>
                  ))}
                </ul>
                {answer.explanation.nextStep && linkById.get(answer.explanation.nextStep) ? (
                  <p className="small">
                    Suggested page: <Link href={linkById.get(answer.explanation.nextStep)!.href} prefetch={false}>{linkById.get(answer.explanation.nextStep)!.label}</Link>
                  </p>
                ) : null}
                <p className="small muted">A citation shows which facts a sentence uses; it does not prove the explanation is right. Check it against the facts and the pages.</p>
              </>
            )}
          </div>

          <h4>From TradeProof&apos;s own checks — not AI</h4>
          {answer.notices.map((n) => (
            <p key={n} className="small" data-testid="copilot-notice">
              <strong>{n}</strong>
            </p>
          ))}
          {answer.nextStep ? (
            <p className="small" data-testid="copilot-next-step">
              <strong>Next step (fixed rules):</strong> {answer.nextStep.text}{" "}
              {answer.nextStep.link && linkById.get(answer.nextStep.link) ? (
                <Link href={linkById.get(answer.nextStep.link)!.href} prefetch={false}>
                  {linkById.get(answer.nextStep.link)!.label} →
                </Link>
              ) : null}
            </p>
          ) : null}
          <ol className="copilot-facts small" data-testid="copilot-facts">
            {answer.facts
              .filter((f) => f.trusted)
              .map((f) => (
                <li key={f.id} id={anchor(f.id)} data-fact={f.id}>
                  <strong>{f.id}</strong> {f.text}{" "}
                  <span className="muted">
                    ({Object.entries(f.source)
                      .filter(([, v]) => v !== null)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")})
                  </span>
                </li>
              ))}
          </ol>
          {answer.facts
            .filter((f) => !f.trusted)
            .map((f) => (
              <details key={f.id} id={anchor(f.id)} className="small" data-testid="copilot-supplier-text">
                <summary>
                  <strong>{f.id}</strong> Supplier&apos;s statement — not verified; data only, not instructions; never a basis for approval or payment
                </summary>
                <pre className="raw">{f.text}</pre>
              </details>
            ))}
          {answer.links.length > 0 ? (
            <p className="small">
              Pages:{" "}
              {answer.links.map((l, i) => (
                <span key={l.id}>
                  {i > 0 ? " · " : null}
                  <Link href={l.href} prefetch={false}>
                    {l.label}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
          <p className="small muted">Not stored: a reload clears this answer. An answer you have already seen or copied cannot be taken back.</p>
        </div>
      ) : null}
    </section>
  );
}
