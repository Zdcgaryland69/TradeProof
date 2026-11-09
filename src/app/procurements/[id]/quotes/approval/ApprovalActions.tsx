"use client";

// Client controls of the approval page: per-item confirmations + Approve, free-text requirement classification, and
// revoke. Each sends ids, the preview digest and confirmation keys only — never an amount, currency, payee or term.
// One request key per form instance, so a double click or a retry replays instead of creating a second row (the server's
// idempotency and its one-active-approval rule are the protection; hiding the button after a save is only feedback).

import { csrfHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en";

const t = en.approval;

type SavedRead = { kind: "checking" } | { kind: "failed" } | { kind: "state"; state: string; reasons: string[] };

async function post(url: string, key: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { ...csrfHeaders(), "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body), cache: "no-store" });
  const data = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  return { res, data };
}

export function ApproveForm({
  requestId,
  ids,
  digest,
  confirms,
  blocked,
}: {
  requestId: string;
  ids: { seriesId: string; versionId: string; runId: string; baseRunId: string | null };
  digest: string;
  confirms: { key: string; text: string }[];
  blocked: boolean;
}) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Set once the server has stored the approval. From then on this form never posts again (the button is gone); the
  // state shown is read back from the server, never assumed from the POST.
  const [saved, setSaved] = useState<{ id: string; read: SavedRead } | null>(null);
  const [unknown, setUnknown] = useState<null | "unknown" | "checking" | "notStored" | "checkFailed">(null);
  const all = confirms.every((c) => checked.has(c.key));

  async function readBack(approvalId: string) {
    setSaved({ id: approvalId, read: { kind: "checking" } });
    try {
      const res = await fetch(`/api/procurements/${requestId}/approvals/${approvalId}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { validity?: { state?: string; reasons?: string[] } } | null;
      const state = data?.validity?.state;
      if (!res.ok || !state) throw new Error("no state");
      setSaved({ id: approvalId, read: { kind: "state", state, reasons: data?.validity?.reasons ?? [] } });
      router.refresh();
    } catch {
      setSaved({ id: approvalId, read: { kind: "failed" } });
    }
  }

  async function approve() {
    if (busy || saved || blocked || !all) return;
    setBusy(true);
    setMessage(null);
    try {
      const { res, data } = await post(`/api/procurements/${requestId}/approvals`, key, { ...ids, previewDigest: digest, confirmed: confirms.map((c) => c.key) });
      const approvalId = (data as { approval?: { id?: string } } | null)?.approval?.id;
      if (res.ok && approvalId) {
        setBusy(false);
        await readBack(approvalId);
        return;
      } else if (res.ok) {
        setMessage({ kind: "ok", text: t.approvedOk });
        router.refresh();
      } else if (data?.code === "ALREADY_APPROVED") {
        setMessage({ kind: "error", text: t.approveFailed(data.message ?? "") });
        router.refresh();
      } else if (data?.code === "BASIS_CHANGED") {
        setMessage({ kind: "error", text: t.basisChanged });
        router.refresh();
      } else if (res.status >= 500 || !data) setUnknown("unknown");
      else setMessage({ kind: "error", text: t.approveFailed(data?.message ?? `HTTP ${res.status}`) });
    } catch {
      // 8 Nov: no usable answer — the approval may or may not be stored. Never "Not approved"; the button is withheld
      // until the user has checked the stored state (read-only).
      setUnknown("unknown");
    }
    setBusy(false);
  }

  // Read-only: the approvals of this version as stored (GET …/approvals?statusFor=; writes nothing, not even an
  // INVALIDATED event). Found Active → shown as Active; none → the form comes back (same request key).
  async function checkStatus() {
    setUnknown("checking");
    try {
      const res = await fetch(`/api/procurements/${requestId}/approvals?statusFor=${encodeURIComponent(ids.versionId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { here?: { id: string; state: string; reasons: string[] }[] } | null;
      if (!res.ok || !data?.here) throw new Error("no state");
      const active = data.here.find((a) => a.state === "ACTIVE");
      if (active) {
        setUnknown(null);
        setSaved({ id: active.id, read: { kind: "state", state: "ACTIVE", reasons: [] } });
      } else setUnknown("notStored");
    } catch {
      setUnknown("checkFailed");
    }
  }

  if (unknown && unknown !== "notStored") {
    return (
      <div data-testid="approve-unknown" data-check={unknown} role="alert">
        <p className="small notice warn">{unknown === "checkFailed" ? en.editor.checkFailed : en.editor.outcomeUnknown}</p>
        <button type="button" disabled={unknown === "checking"} onClick={() => void checkStatus()} data-testid="approve-check-status">
          {unknown === "checking" ? en.editor.checking : en.editor.checkStatus}
        </button>
      </div>
    );
  }

  if (saved) {
    const r = saved.read;
    return (
      <div data-testid="approve-result" data-read={r.kind} data-state={r.kind === "state" ? r.state : ""} role="status">
        {r.kind === "checking" ? <p className="small">{t.savedChecking}</p> : null}
        {r.kind === "state" && r.state === "ACTIVE" ? (
          <p className="approved-active">
            <strong>{t.approvedActive}</strong> <span className="small">{t.approvedActiveNote}</span>
          </p>
        ) : null}
        {r.kind === "state" && r.state !== "ACTIVE" ? (
          <p className="small alert warn">
            {t.savedStateIs(t.state[r.state] ?? r.state)}
            {r.reasons.length > 0 ? ` ${t.reasonsLabel} ${r.reasons.map((x) => t.reasons[x.split(":")[0]] ?? x).join("; ")}` : ""}
          </p>
        ) : null}
        {r.kind === "failed" ? (
          <p className="small alert warn" data-testid="approve-refresh-failed">
            {t.savedRefreshFailed}{" "}
            <button type="button" onClick={() => void readBack(saved.id)} data-testid="approve-recheck">
              {t.checkStateAgain}
            </button>
          </p>
        ) : null}
        <p className="small">
          <a href="#approval-history" data-testid="approve-history-link">
            {t.viewHistory}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div data-testid="approve-form">
      {unknown === "notStored" ? (
        <p className="small" role="status" data-testid="approve-not-stored">
          {t.notStoredAfterCheck}
        </p>
      ) : null}
      {confirms.length > 0 ? (
        <ul className="small plain" data-testid="confirm-list">
          {confirms.map((c) => (
            <li key={c.key}>
              <label>
                <input
                  type="checkbox"
                  data-confirm={c.key}
                  checked={checked.has(c.key)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(c.key);
                    else next.delete(c.key);
                    setChecked(next);
                  }}
                />{" "}
                {c.text}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="primary" disabled={busy || blocked || !all} onClick={() => void approve()} data-testid="approve">
        {busy ? t.approving : t.approve}
      </button>
      {message ? (
        <p className={`small ${message.kind === "error" ? "error" : "ok"}`} role={message.kind === "error" ? "alert" : "status"} data-testid="approve-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

export type ClassView = { id: string; decision: "NOT_KEY" | "KEY_IN_QUOTE" | "KEY_NOT_IN_QUOTE"; reason: string; excerpt: string | null; createdAt: string };
type Decision = ClassView["decision"];
const r = t.requirement;

/**
 * 7 Nov: one free-text requirement with its current classification, its history and (buyer only) the form to classify
 * or reclassify it. No decision is pre-selected. A reclassification names the row it replaces (`replaces`); the server
 * refuses a stale or blind one (409) and records an identical re-save as UNCHANGED. Cancel writes nothing.
 */
export function RequirementCard({
  requestId,
  seriesId,
  versionId,
  subject,
  label,
  text,
  current,
  earlier,
  canWrite,
  approvalActive,
  paid,
  savedAt,
  runId,
  baseRunId,
}: {
  requestId: string;
  seriesId: string;
  versionId: string;
  subject: string;
  label: string;
  text: string;
  current: ClassView | null;
  earlier: ClassView[];
  canWrite: boolean;
  approvalActive: boolean;
  paid: boolean;
  /** Pre-formatted times (server side, UTC), by classification id. */
  savedAt: Record<string, string>;
  /** The run the page previews; the read-only status check asks the same preview. */
  runId: string;
  baseRunId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(current === null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // 8 Nov: a save without a usable answer. Save stays withheld until the stored state has been checked (read-only).
  const [unknown, setUnknown] = useState<null | "unknown" | "checking" | "checkFailed" | "stored" | "notStored">(null);
  const formId = `cls-${subject.replace(/[^a-zA-Z0-9]/g, "-")}`;

  function reset() {
    setDecision(null);
    setReason("");
    setExcerpt("");
    setKey(crypto.randomUUID());
  }

  async function save() {
    if (busy || !decision || reason.trim() === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const { res, data } = await post(`/api/procurements/${requestId}/quotes/${seriesId}/versions/${versionId}/requirement-classifications`, key, {
        subject,
        decision,
        reason,
        ...(decision === "KEY_IN_QUOTE" ? { excerpt } : {}),
        ...(current ? { replaces: current.id } : {}),
      });
      const status = (data as { status?: string } | null)?.status;
      if (res.ok && status === "UNCHANGED") setMessage({ kind: "ok", text: r.unchanged });
      else if (res.ok) {
        setMessage({ kind: "ok", text: r.saved });
        reset();
        setOpen(false);
        router.refresh();
      } else if (data?.code === "CLASSIFICATION_CHANGED") setMessage({ kind: "error", text: r.stale });
      else if (res.status >= 500 || !data) setUnknown("unknown");
      else setMessage({ kind: "error", text: data?.message ?? `HTTP ${res.status}` });
    } catch {
      setUnknown("unknown");
    }
    setBusy(false);
  }

  // Read-only: the approval preview (GET, computed, nothing stored) lists the latest classification per requirement.
  // Newer than the one this card shows → the save (or another one) is stored; same → nothing new is stored.
  async function checkStatus() {
    setUnknown("checking");
    try {
      const q = new URLSearchParams({ series: seriesId, version: versionId, run: runId, ...(baseRunId ? { baseRun: baseRunId } : {}) });
      const res = await fetch(`/api/procurements/${requestId}/approvals?${q.toString()}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { evaluation?: { snapshot?: { classifications?: { id: string; subject: string }[] } } } | null;
      const list = data?.evaluation?.snapshot?.classifications;
      if (!res.ok || !list) throw new Error("no state");
      const latest = list.find((c) => c.subject === subject)?.id ?? null;
      setUnknown(latest !== (current?.id ?? null) ? "stored" : "notStored");
    } catch {
      setUnknown("checkFailed");
    }
  }

  const ready = decision !== null && reason.trim() !== "" && (decision !== "KEY_IN_QUOTE" || excerpt.trim() !== "");
  return (
    <article className="req-card" data-classify={subject} data-current={current?.decision ?? "NONE"}>
      <h3>{label}</h3>
      <p className="req-text">“{text}”</p>
      <div className="req-current">
        <p className="small muted">{r.current}</p>
        {current ? (
          <>
            <p className={`req-decision d-${current.decision}`} data-testid="classification-current">
              <span className="mark" aria-hidden="true">{current.decision === "KEY_NOT_IN_QUOTE" ? "✕" : "✓"}</span> {t.classify[current.decision]}
            </p>
            <p className="small">
              {r.reasonLabel} {current.reason}
            </p>
            {current.excerpt ? (
              <p className="small">
                {r.excerptLabel} <q>{current.excerpt}</q>
              </p>
            ) : null}
            <p className="small muted">{r.savedAt(savedAt[current.id] ?? current.createdAt)}</p>
          </>
        ) : (
          <p className="req-decision d-NONE" data-testid="classification-current">
            <span className="mark" aria-hidden="true">!</span> {r.none}
          </p>
        )}
      </div>
      {earlier.length > 0 ? (
        <details className="req-history small" data-testid="classification-history">
          <summary>{r.history(earlier.length)}</summary>
          <p className="muted">{r.historyNote}</p>
          <ol reversed>
            {[...earlier].reverse().map((c) => (
              <li key={c.id}>
                <strong>{t.classify[c.decision]}</strong> — {c.reason}
                {c.excerpt ? (
                  <>
                    {" "}
                    · <q>{c.excerpt}</q>
                  </>
                ) : null}{" "}
                <span className="muted">({savedAt[c.id] ?? c.createdAt})</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {!canWrite ? (
        <p className="small muted">{t.classifyBuyerOnly}</p>
      ) : !open ? (
        <div className="actions">
          <button type="button" onClick={() => { reset(); setMessage(null); setUnknown(null); setOpen(true); }} aria-controls={formId} aria-expanded="false" data-testid="reclassify">
            {r.reclassify}
          </button>
        </div>
      ) : (
        <fieldset className="classify" id={formId} data-testid="classify-form">
          <legend>{current ? r.reclassify : t.classifyHeading}</legend>
          {current ? <p className="small">{r.replacing}</p> : null}
          {current && approvalActive ? (
            <p className="small notice warn" role="note" data-testid="classify-warn-active">
              {r.warnActive}
            </p>
          ) : null}
          {paid ? (
            <p className="small notice warn" role="note" data-testid="classify-warn-paid">
              {r.warnPaid}
            </p>
          ) : null}
          <div className="choice-list" role="radiogroup" aria-label={label}>
            {(["NOT_KEY", "KEY_IN_QUOTE", "KEY_NOT_IN_QUOTE"] as const).map((d) => (
              <label key={d} className="choice">
                <input type="radio" name={`d-${subject}`} value={d} checked={decision === d} onChange={() => setDecision(d)} /> <span>{t.classify[d]}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>{t.classify.reason}</span>
            <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-field="reason" />
          </label>
          {decision === "KEY_IN_QUOTE" ? (
            <label className="field">
              <span>{t.classify.excerpt}</span>
              <input type="text" value={excerpt} maxLength={2000} onChange={(e) => setExcerpt(e.target.value)} data-field="excerpt" />
            </label>
          ) : null}
          <div className="actions">
            <button type="button" className="primary" disabled={busy || !ready || (unknown !== null && unknown !== "notStored")} onClick={() => void save()} data-testid="classify-save">
              {busy ? t.classify.saving : t.classify.save}
            </button>
            {current ? (
              <button type="button" disabled={busy} onClick={() => { reset(); setMessage(null); setOpen(false); }} data-testid="classify-cancel">
                {r.cancel}
              </button>
            ) : null}
            {decision === null ? <span className="small muted">{r.chooseFirst}</span> : null}
          </div>
        </fieldset>
      )}
      {unknown ? (
        <div className="small" data-testid="classify-unknown" data-check={unknown} role={unknown === "notStored" || unknown === "stored" ? "status" : "alert"}>
          <p className="notice warn">
            {unknown === "checkFailed" ? en.editor.checkFailed : unknown === "stored" ? r.checkedStored : unknown === "notStored" ? r.checkedNotStored : en.editor.outcomeUnknown}
          </p>
          {unknown === "unknown" || unknown === "checking" || unknown === "checkFailed" ? (
            <button type="button" disabled={unknown === "checking"} onClick={() => void checkStatus()} data-testid="classify-check-status">
              {unknown === "checking" ? en.editor.checking : en.editor.checkStatus}
            </button>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p className={`small ${message.kind === "error" ? "error" : "ok"}`} role={message.kind === "error" ? "alert" : "status"} data-testid="classify-message">
          {message.text}
        </p>
      ) : null}
    </article>
  );
}

export function RevokeForm({ requestId, approvalId, versionId }: { requestId: string; approvalId: string; versionId: string }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<null | "unknown" | "checking" | "checkFailed" | "notStored">(null);

  async function revoke() {
    if (busy || note.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await post(`/api/procurements/${requestId}/approvals/${approvalId}/revoke`, key, { note });
      if (res.ok) router.refresh();
      else if (res.status >= 500 || !data) setUnknown("unknown");
      else setError(data?.message ?? `HTTP ${res.status}`);
    } catch {
      setUnknown("unknown"); // 8 Nov: the revocation may be stored — never "not revoked"
    }
    setBusy(false);
  }

  // Read-only state of this approval (GET …/approvals?statusFor=<its version>; writes nothing).
  async function checkStatus() {
    setUnknown("checking");
    try {
      const res = await fetch(`/api/procurements/${requestId}/approvals?statusFor=${encodeURIComponent(versionId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { here?: { id: string; state: string }[] } | null;
      const mine = data?.here?.find((a) => a.id === approvalId);
      if (!res.ok || !mine) throw new Error("no state");
      if (mine.state === "ACTIVE") setUnknown("notStored");
      else {
        setUnknown(null);
        router.refresh();
      }
    } catch {
      setUnknown("checkFailed");
    }
  }

  return (
    <div className="small" data-testid="revoke-form">
      <label>
        {t.revokeReason} <input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-field="revoke-reason" />
      </label>{" "}
      <button type="button" disabled={busy || note.trim() === "" || (unknown !== null && unknown !== "notStored")} onClick={() => void revoke()} data-testid="revoke">
        {busy ? t.revoking : t.revoke}
      </button>
      {unknown ? (
        <div data-testid="revoke-unknown" data-check={unknown} role={unknown === "notStored" ? "status" : "alert"}>
          <p className="notice warn">{unknown === "checkFailed" ? en.editor.checkFailed : unknown === "notStored" ? t.revokeNotStored : en.editor.outcomeUnknown}</p>
          {unknown !== "notStored" ? (
            <button type="button" disabled={unknown === "checking"} onClick={() => void checkStatus()} data-testid="revoke-check-status">
              {unknown === "checking" ? en.editor.checking : en.editor.checkStatus}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="small error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
