"use client";

// Composer for a new quote (series + version 1) or a new version of an existing series.
// Edit → Preview → Save. The pasted text is sent exactly as it is in the text box (browsers report line
// breaks as LF); it is never trimmed or rewritten. On any refusal the input stays.
//
// Duplicate protection: one idempotency key per logical save. Pressing Save again with the same content
// (double click, retry after a lost response) reuses the key, so the server returns the original result
// instead of creating a second version. Changing the content starts a new key.

import { csrfHeaders } from "@/lib/csrf-client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldError } from "@/lib/procurement";
import {
  CONTENT_KIND_LABELS,
  QUOTE_LIMITS,
  QUOTE_SOURCE_LABELS,
  type QuoteContentKind,
  type QuoteSeries,
  type QuoteSource,
  type QuoteVersion,
  type QuoteVersionSummary,
} from "@/lib/quote-versions";
import type { QuoteDemoSample } from "@/server/quotes/demo";
import { RawText } from "./QuoteParts";

export interface SavedQuote {
  series: QuoteSeries;
  version: QuoteVersion;
  message: string;
}

type Props = {
  requestId: string;
  requestRevision: number;
  defaultSupplier: string | null;
  /** null = new series. */
  series: QuoteSeries | null;
  demos: QuoteDemoSample[];
  onSaved: (saved: SavedQuote) => void;
  onCancel: () => void;
  onRequestRevision: (revision: number) => void;
  onRefreshSeries: () => Promise<QuoteSeries[] | null>;
};

interface Draft {
  name: string;
  supplierDisplayName: string;
  contentKind: QuoteContentKind;
  supplementsVersionId: string;
  rawText: string;
  supplierQuoteDate: string;
  sourceNote: string;
  revisionNote: string;
  /** USER_PASTE or TEST_FIXTURE chosen by the user; DEMO_SAMPLE only via Load demo. */
  source: QuoteSource;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "invalid"; message: string; errors: FieldError[] }
  | { kind: "failed"; message: string }
  | { kind: "request-changed"; currentRevision: number }
  | { kind: "version-conflict"; latest: QuoteVersionSummary };

interface Reply {
  ok?: boolean;
  code?: string;
  message?: string;
  errors?: FieldError[];
  series?: QuoteSeries;
  version?: QuoteVersion;
  currentRevision?: number;
  latest?: QuoteVersionSummary;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Quote name",
  supplierDisplayName: "Supplier",
  rawText: "Quote text",
  contentKind: "Content type",
  supplementsVersionId: "Supplements version",
  supplierQuoteDate: "Supplier's quote date",
  sourceNote: "Source note",
  revisionNote: "Revision note",
  source: "Source",
};

export default function QuoteComposer({ requestId, requestRevision, defaultSupplier, series, demos, onSaved, onCancel, onRequestRevision, onRefreshSeries }: Props) {
  const isRevision = series !== null;
  const latestOf = (s: QuoteSeries | null) => (s ? s.versions[s.versions.length - 1] : null);
  const empty: Draft = {
    name: "",
    supplierDisplayName: defaultSupplier ?? "",
    contentKind: "FULL_QUOTE",
    supplementsVersionId: latestOf(series)?.id ?? "",
    rawText: "",
    supplierQuoteDate: "",
    sourceNote: "",
    revisionNote: "",
    source: "USER_PASTE",
  };
  const [draft, setDraft] = useState<Draft>(empty);
  const [step, setStep] = useState<"edit" | "preview">("edit");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [baseVersion, setBaseVersion] = useState<QuoteVersionSummary | null>(latestOf(series));
  const [linkedRevision, setLinkedRevision] = useState(requestRevision);
  const attempt = useRef<{ key: string; body: string } | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(empty), [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const saving = status.kind === "saving";
  const errorsByField = status.kind === "invalid" ? Object.fromEntries(status.errors.map((e) => [e.field, e.message])) : {};

  useEffect(() => {
    if (status.kind !== "idle" && status.kind !== "saving") {
      outcomeRef.current?.scrollIntoView({ block: "center" });
      outcomeRef.current?.focus({ preventScroll: true });
    }
  }, [status]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (status.kind === "invalid" || status.kind === "failed") setStatus({ kind: "idle" });
  }

  function loadDemo(sample: QuoteDemoSample) {
    if (dirty && !window.confirm("Replace what you have entered with the SYNTHETIC demo quote?")) return;
    setDraft((prev) => ({
      ...prev,
      name: isRevision ? prev.name : sample.name,
      supplierDisplayName: isRevision ? prev.supplierDisplayName : sample.supplierDisplayName,
      rawText: sample.text,
      sourceNote: sample.sourceNote,
      supplierQuoteDate: sample.supplierQuoteDate ?? "",
      source: "DEMO_SAMPLE",
    }));
    setStatus({ kind: "idle" });
    setStep("edit");
  }

  function body(): Record<string, unknown> {
    const common = {
      expectedRequestRevision: linkedRevision,
      rawText: draft.rawText,
      contentKind: draft.contentKind,
      source: draft.source,
      sourceNote: draft.sourceNote,
      supplierQuoteDate: draft.supplierQuoteDate,
      revisionNote: draft.revisionNote,
      ...(draft.contentKind === "SUPPLEMENT" ? { supplementsVersionId: draft.supplementsVersionId || null } : {}),
    };
    return isRevision
      ? { ...common, expectedLatestVersionId: baseVersion?.id ?? null }
      : { ...common, name: draft.name, supplierDisplayName: draft.supplierDisplayName };
  }

  async function save() {
    const payload = body();
    const text = JSON.stringify(payload);
    if (!attempt.current || attempt.current.body !== text) attempt.current = { key: crypto.randomUUID(), body: text };
    const url = isRevision ? `/api/procurements/${requestId}/quotes/${series!.id}/versions` : `/api/procurements/${requestId}/quotes`;
    setStatus({ kind: "saving" });
    let status = 0;
    let data: Reply | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...csrfHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey: attempt.current.key }),
        cache: "no-store",
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as Reply | null;
    } catch {
      status = 0;
    }
    if ((status === 201 || status === 200) && data?.series && data.version) {
      onSaved({ series: data.series, version: data.version, message: data.message ?? `Saved as version ${data.version.versionNumber}.` });
      return;
    }
    if (status === 409 && data?.code === "REQUEST_CHANGED" && typeof data.currentRevision === "number") {
      onRequestRevision(data.currentRevision);
      setStatus({ kind: "request-changed", currentRevision: data.currentRevision });
      return;
    }
    if (status === 409 && data?.code === "VERSION_CONFLICT" && data.latest) {
      void onRefreshSeries();
      setStatus({ kind: "version-conflict", latest: data.latest });
      return;
    }
    if (status === 422 && data?.errors) {
      setStatus({ kind: "invalid", message: data.message ?? "Some fields need attention.", errors: data.errors });
      setStep("edit");
      return;
    }
    const reason = status === 0 ? "could not reach the local server" : (data?.message ?? `HTTP ${status}`);
    setStatus({
      kind: "failed",
      message: `Save failed: ${reason}. Your text is still here. Press Save again: a repeated save is recognised and never creates a second version.`,
    });
  }

  function cancel() {
    if (dirty && !window.confirm("Discard this unsaved quote text?")) return;
    onCancel();
  }

  const fieldError = (field: string) =>
    errorsByField[field] ? (
      <span className="error" role="alert">
        {errorsByField[field]}
      </span>
    ) : null;
  const chars = [...draft.rawText].length;
  const blank = draft.rawText.trim() === "";

  return (
    <section className="card composer" aria-label={isRevision ? "Add a revision" : "New quote"}>
      <h2>{isRevision ? `Add a revision to “${series!.name}”` : "New quote 新报价"}</h2>
      {isRevision ? (
        <p className="small muted">
          Will be saved as version {(baseVersion?.versionNumber ?? 0) + 1}, based on version {baseVersion?.versionNumber}. Quote name and supplier are
          inherited: <span className="pre">{series!.name}</span> · {series!.supplierDisplayName ?? "supplier not named"}.
        </p>
      ) : null}

      {demos.length > 0 ? (
        <div className="demo-box">
          <span className="small muted">Demo data (fictional, from samples/synthetic). Fills the editor only; nothing is saved until you click Save.</span>
          {demos.map((d) => (
            <button key={d.key} type="button" onClick={() => loadDemo(d)} disabled={saving} data-demo={d.key}>
              Load demo: {d.label}
            </button>
          ))}
        </div>
      ) : null}
      {draft.source === "DEMO_SAMPLE" ? (
        <p className="sandbox-banner" role="note">
          SYNTHETIC / DEMO quote loaded · fictional · it will be saved with source “{QUOTE_SOURCE_LABELS.DEMO_SAMPLE}”
        </p>
      ) : null}

      {step === "edit" ? (
        <div className="grid">
          {!isRevision ? (
            <>
              <div className="field">
                <label htmlFor="q-name">
                  Quote name 报价名称<span className="req"> *</span>
                </label>
                <input id="q-name" type="text" value={draft.name} maxLength={QUOTE_LIMITS.name} placeholder="e.g. supplier's quote number" onChange={(e) => set("name", e.target.value)} />
                {fieldError("name")}
              </div>
              <div className="field">
                <label htmlFor="q-supplier">Supplier 供应商 (display name)</label>
                <input id="q-supplier" type="text" value={draft.supplierDisplayName} maxLength={QUOTE_LIMITS.supplierDisplayName} onChange={(e) => set("supplierDisplayName", e.target.value)} />
                <span className="hint">As written by you. Not a verified identity; never used to choose a PayPal payee.</span>
                {fieldError("supplierDisplayName")}
              </div>
            </>
          ) : null}

          <fieldset className="field full kind">
            <legend>Content type 内容类型</legend>
            {(["FULL_QUOTE", "SUPPLEMENT"] as const).map((kind) => (
              <label key={kind} className="radio">
                <input
                  type="radio"
                  name="q-kind"
                  value={kind}
                  checked={draft.contentKind === kind}
                  disabled={kind === "SUPPLEMENT" && !isRevision}
                  onChange={() => set("contentKind", kind)}
                />{" "}
                {CONTENT_KIND_LABELS[kind]}
              </label>
            ))}
            <span className="hint">
              Check this: is the text the supplier&apos;s complete quote, or only an addition (e.g. a freight note)? A supplement never replaces a full quote,
              and terms it does not mention are not treated as cancelled.{!isRevision ? " The first version must be a full quote." : ""}
            </span>
            {draft.contentKind === "SUPPLEMENT" && series ? (
              <label className="radio">
                Adds to version{" "}
                <select value={draft.supplementsVersionId} onChange={(e) => set("supplementsVersionId", e.target.value)} aria-label="Version this supplement adds to">
                  {series.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber} ({v.contentKind === "FULL_QUOTE" ? "full quote" : "supplement"})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {fieldError("contentKind")}
            {fieldError("supplementsVersionId")}
          </fieldset>

          <div className="field full">
            <label htmlFor="q-text">
              Quote text 报价原文 (paste as plain text, Chinese or English)<span className="req"> *</span>
            </label>
            <textarea id="q-text" rows={14} className="mono" value={draft.rawText} onChange={(e) => set("rawText", e.target.value)} spellCheck={false} />
            <span className="hint">
              {chars.toLocaleString()} / {QUOTE_LIMITS.rawText.toLocaleString()} characters. Saved exactly as shown (no trimming or translation; line breaks are
              stored as the browser reports them, LF). Plain text only. PDF, images and links are not read.
            </span>
            {fieldError("rawText")}
          </div>

          <div className="field">
            <label htmlFor="q-date">Supplier&apos;s quote date (optional)</label>
            <input id="q-date" type="date" min="2000-01-01" max="2100-12-31" value={draft.supplierQuoteDate} onChange={(e) => set("supplierQuoteDate", e.target.value)} />
            {fieldError("supplierQuoteDate")}
          </div>
          <div className="field">
            <label htmlFor="q-source">Source 来源</label>
            {draft.source === "DEMO_SAMPLE" ? (
              <input id="q-source" type="text" value={QUOTE_SOURCE_LABELS.DEMO_SAMPLE} readOnly />
            ) : (
              <select id="q-source" value={draft.source} onChange={(e) => set("source", e.target.value as QuoteSource)}>
                <option value="USER_PASTE">{QUOTE_SOURCE_LABELS.USER_PASTE}</option>
                <option value="TEST_FIXTURE">{QUOTE_SOURCE_LABELS.TEST_FIXTURE} (not a real supplier document)</option>
              </select>
            )}
            {fieldError("source")}
          </div>
          <div className="field">
            <label htmlFor="q-source-note">Source note (optional)</label>
            <input id="q-source-note" type="text" value={draft.sourceNote} maxLength={QUOTE_LIMITS.sourceNote} placeholder="e.g. email from supplier, 15 Oct" onChange={(e) => set("sourceNote", e.target.value)} />
            {fieldError("sourceNote")}
          </div>
          <div className="field full">
            <label htmlFor="q-rev-note">Revision note 修订说明 (optional)</label>
            <textarea id="q-rev-note" rows={2} value={draft.revisionNote} maxLength={QUOTE_LIMITS.revisionNote} placeholder="e.g. supplier added freight cost" onChange={(e) => set("revisionNote", e.target.value)} />
            <span className="hint">Your own description of this version. It is saved with the version and shown as written by you, not as a verified finding.</span>
            {fieldError("revisionNote")}
          </div>
        </div>
      ) : (
        <div className="preview" aria-label="Preview">
          <p className="small">
            <strong>Preview — not saved yet.</strong> {isRevision ? `Version ${(baseVersion?.versionNumber ?? 0) + 1}` : "Version 1"} ·{" "}
            {CONTENT_KIND_LABELS[draft.contentKind]}
            {draft.contentKind === "SUPPLEMENT" && series ? ` to v${series.versions.find((v) => v.id === draft.supplementsVersionId)?.versionNumber ?? "?"}` : ""} ·{" "}
            {QUOTE_SOURCE_LABELS[draft.source]} · {chars.toLocaleString()} characters · linked to request revision {linkedRevision}
          </p>
          {!isRevision ? (
            <p className="small pre">
              {draft.name || "(no name)"} · supplier: {draft.supplierDisplayName || "not named"}
            </p>
          ) : null}
          {draft.revisionNote ? <p className="small pre">Revision note (yours): {draft.revisionNote}</p> : null}
          <RawText text={draft.rawText} label="Quote text preview" />
          <p className="hint">Once saved, this version cannot be changed or deleted. Corrections are saved as a new version.</p>
        </div>
      )}

      <div ref={outcomeRef} tabIndex={-1} className="outcome">
        {status.kind === "invalid" ? (
          <div className="card alert error-box" role="alert">
            <strong>Not saved. {status.message}</strong>
            <ul className="small">
              {status.errors.map((e) => (
                <li key={e.field + e.message}>
                  {FIELD_LABELS[e.field] ?? e.field}: {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {status.kind === "failed" ? (
          <div className="card alert error-box" role="alert">
            {status.message}
          </div>
        ) : null}
        {status.kind === "request-changed" ? (
          <div className="card alert warn" role="alert">
            <h2>Request updated — nothing was saved</h2>
            <p>
              The procurement request was changed after this page loaded (now revision {status.currentRevision}; you started from revision {linkedRevision}).
              Your text is kept. Review the request first if needed (
              <a href={`/procurements/${requestId}`} target="_blank" rel="noreferrer">
                opens in a new tab
              </a>
              ).
            </p>
            <button
              type="button"
              onClick={() => {
                setLinkedRevision(status.currentRevision);
                setStatus({ kind: "idle" });
              }}
            >
              Link to revision {status.currentRevision} instead
            </button>
          </div>
        ) : null}
        {status.kind === "version-conflict" ? (
          <div className="card alert warn" role="alert">
            <h2>Edit conflict: nothing was saved</h2>
            <p>
              Version {status.latest.versionNumber} of this quote was saved elsewhere (another tab) at {status.latest.savedAt} after you started. Nothing was overwritten and the order
              of versions is unchanged. Your text is kept. Look at version {status.latest.versionNumber} in the list, then decide.
            </p>
            <button
              type="button"
              onClick={() => {
                setBaseVersion(status.latest);
                setStatus({ kind: "idle" });
              }}
            >
              Save mine as version {status.latest.versionNumber + 1} (after v{status.latest.versionNumber})
            </button>
          </div>
        ) : null}
      </div>

      <div className="actions sticky">
        {step === "edit" ? (
          <button type="button" className="primary" onClick={() => setStep("preview")} disabled={blank || saving || status.kind === "request-changed" || status.kind === "version-conflict"}>
            Preview
          </button>
        ) : (
          <>
            <button type="button" className="primary" onClick={() => void save()} disabled={saving || status.kind === "request-changed" || status.kind === "version-conflict"}>
              {saving ? "Saving…" : isRevision ? `Save as version ${(baseVersion?.versionNumber ?? 0) + 1}` : "Save version 1"}
            </button>
            <button type="button" onClick={() => setStep("edit")} disabled={saving}>
              Back to edit
            </button>
          </>
        )}
        <button type="button" onClick={cancel} disabled={saving}>
          Cancel
        </button>
        {status.kind === "request-changed" || status.kind === "version-conflict" ? (
          <strong className="error" role="status">
            Not saved. See the message above.
          </strong>
        ) : status.kind === "invalid" || status.kind === "failed" ? (
          <strong className="error" role="status">
            Not saved. See the message above.
          </strong>
        ) : null}
        {dirty ? (
          <span className="unsaved" role="status">
            ● Unsaved quote
          </span>
        ) : (
          <span className="muted small">Nothing entered yet</span>
        )}
        {blank && step === "edit" ? <span className="muted small">Paste the quote text to preview.</span> : null}
      </div>
    </section>
  );
}
