"use client";

// Editor for ONE bilingual clarification draft. Loading only reads. The check runs in the browser with the
// same pure code the server uses (no request, no model); its result is shown only for the exact text it was
// run on — any edit makes it out of date until the user runs it again. Saving sends the user's own texts and
// selection with the revision it was based on (conflicts are refused, unchanged saves write nothing).
// Copying puts text on the clipboard and nothing else: nothing is marked sent, answered or confirmed.

import { csrfHeaders } from "@/lib/csrf-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { assemble, checkDraft, contentKey, type DraftCheck, type DraftContent, type DraftQuestion, type Finding, type GeneratedDraft, type Lang, type PartCheck } from "@/lib/clarification";
import { en } from "@/i18n/en";
import { REPLY_FORM_EVENT, type ReplyFormPointer } from "./ReplyTracker";

const t = en.clarification;
const cmp = en.comparison;

type View = "en" | "zh" | "side";
type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;
interface Revision {
  revision: number;
  content: DraftContent;
}

const LANG_LABEL: Record<Lang, string> = { en: t.langEn, zh: t.langZh };

function findingText(f: Finding): string {
  const lang = f.lang === "both" ? `${t.langEn} + ${t.langZh}` : LANG_LABEL[f.lang];
  const kind = f.kind ? (t.kinds[f.kind] ?? f.kind) : "";
  return (t.findings[f.code] ?? (() => f.code))(lang, kind, f.expected ?? "", f.found ?? "");
}

function whyText(q: DraftQuestion): string[] {
  return q.origins.map((o) => {
    if (o.kind === "FEE") {
      const reasons = o.note.args.reasons ? o.note.args.reasons.split(",").map((r) => cmp.feeReasons[r] ?? r) : [];
      return `${cmp.feeStatus[o.note.code] ?? o.note.code}${reasons.length ? `: ${reasons.join("; ")}` : ""}`;
    }
    const note = cmp.notes[o.note.code];
    return `${cmp.fields[o.field] ?? o.field} · ${cmp.outcomes[o.outcome]} — ${note ? note(o.note.args) : o.note.code}`;
  });
}

export default function DraftEditor({
  apiBase,
  draftId,
  generated,
  initial,
  latest,
}: {
  apiBase: string;
  draftId: string;
  generated: GeneratedDraft;
  initial: DraftContent;
  latest: Revision;
}) {
  const [content, setContent] = useState<DraftContent>(latest.content);
  const [saved, setSaved] = useState<Revision>(latest);
  const [view, setView] = useState<View>("side");
  const [check, setCheck] = useState<DraftCheck>(() => checkDraft(latest.content, initial));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState<Revision | null>(null);
  const [copyAsk, setCopyAsk] = useState<Lang | null>(null);
  const [fallback, setFallback] = useState<{ lang: Lang; text: string } | null>(null);
  const pendingSave = useRef<{ key: string; content: string } | null>(null);

  const nowKey = useMemo(() => contentKey(content), [content]);
  const savedKey = useMemo(() => contentKey(saved.content), [saved]);
  const dirty = nowKey !== savedKey;
  const checkCurrent = check.checkedKey === nowKey;
  const partById = useMemo(() => new Map(check.parts.map((p) => [p.id, p] as const)), [check]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setText = (lang: Lang, id: string, value: string) =>
    setContent((c) => {
      const next = { ...c, [lang]: { ...c[lang] } };
      if (id === "intro" || id === "closing") next[lang][id] = value;
      else next[lang].questions = { ...c[lang].questions, [id]: value };
      return next;
    });

  const toggle = (id: string) =>
    setContent((c) => {
      const on = !c.selected.includes(id);
      const ids = generated.questions.map((q) => q.id);
      return { ...c, selected: ids.filter((x) => (x === id ? on : c.selected.includes(x))) };
    });

  const reset = (id: string) => {
    if (!window.confirm(t.resetConfirm)) return;
    setText("en", id, initial.en.questions[id]);
    setText("zh", id, initial.zh.questions[id]);
  };

  async function save() {
    // The same content after a lost response → the same key, so the server replays instead of adding a revision.
    if (!pendingSave.current || pendingSave.current.content !== nowKey) pendingSave.current = { key: crypto.randomUUID(), content: nowKey };
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(apiBase, {
        method: "PUT",
        headers: { ...csrfHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ saveKey: pendingSave.current.key, expectedRevision: saved.revision, content }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { code?: string; message?: string; revision?: Revision; current?: Revision; check?: DraftCheck } | null;
      pendingSave.current = null;
      if (res.status === 409 && data?.current) {
        setConflict(data.current);
        setNotice({ tone: "error", text: t.conflict(data.current.revision) });
      } else if (res.ok && data?.revision) {
        setSaved(data.revision);
        setConflict(null);
        if (data.check && data.check.checkedKey === nowKey) setCheck(data.check);
        const r = data.revision.revision;
        setNotice(data.code === "UNCHANGED" ? { tone: "warn", text: t.unchanged(r) } : { tone: "ok", text: data.code === "REPLAYED" ? t.replayed(r) : t.saved(r) });
      } else {
        setNotice({ tone: "error", text: t.saveFailed(data?.message ?? `HTTP ${res.status}`) });
      }
    } catch {
      setNotice({ tone: "error", text: en.editor.outcomeUnknownKeepText });
    } finally {
      setBusy(false);
    }
  }

  function loadSaved() {
    if (!conflict || !window.confirm(t.loadSavedConfirm)) return;
    setContent(conflict.content);
    setSaved(conflict);
    setConflict(null);
    setNotice(null);
  }

  async function doCopy(lang: Lang) {
    setCopyAsk(null);
    const text = assemble(content, lang, generated, draftId);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setFallback(null);
      setNotice({ tone: "ok", text: t.copied(LANG_LABEL[lang]) });
    } catch {
      setFallback({ lang, text });
      setNotice({ tone: "warn", text: t.copyFallback });
    }
  }

  const warnings: string[] = [];
  if (!checkCurrent) warnings.push(t.copyWarnStale);
  else {
    if (check.counts.INCONSISTENT > 0) warnings.push(t.copyWarnInconsistent(check.counts.INCONSISTENT));
    if (check.counts.REVIEW > 0) warnings.push(t.copyWarnReview(check.counts.REVIEW));
  }
  if (dirty) warnings.push(t.copyWarnUnsaved);
  const askCopy = (lang: Lang) => (warnings.length > 0 ? setCopyAsk(lang) : void doCopy(lang));

  const langs: Lang[] = view === "side" ? ["en", "zh"] : [view];
  const total = generated.questions.length;

  return (
    <>
      <section className="card draft-toolbar" aria-label={t.viewsLabel}>
        <div className="lang-tabs" role="tablist" aria-label={t.viewsLabel}>
          {(["en", "zh", "side"] as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "version-tab selected" : "version-tab"} onClick={() => setView(v)} data-view={v}>
              {t.views[v]}
            </button>
          ))}
        </div>
        <p className="small" data-testid="draft-save-state">
          {dirty ? <span className="unsaved">{t.unsaved}</span> : <span className="muted">{t.allSaved(saved.revision)}</span>} · {t.selectedCount(content.selected.length, total)}
        </p>
      </section>

      <section className="card" aria-label={t.intro}>
        <h2>{t.intro}</h2>
        <TextPair id="intro" langs={langs} content={content} initial={initial} onChange={setText} part={checkCurrent ? partById.get("intro") : undefined} />
      </section>

      <section className="card" aria-label={t.questionsHeading} data-testid="draft-questions">
        <h2>{t.questionsHeading}</h2>
        <p className="hint">{t.questionsHint}</p>
        <p className="hint">{t.keptAsWritten}</p>
        <p className="hint">{t.numbersNote}</p>
        {total === 0 ? <p className="small muted" data-testid="draft-no-questions">{t.noQuestions}</p> : null}
        {generated.questions.map((q, i) => {
          const on = content.selected.includes(q.id);
          const copied = on ? content.selected.indexOf(q.id) + 1 : null;
          const part = checkCurrent && on ? partById.get(q.id) : undefined;
          return (
            <article key={q.id} id={`q-${q.id}`} className={`draft-q${on ? "" : " off"}`} data-question={q.id} data-template={q.template} data-selected={on ? "yes" : "no"} data-check={part?.status ?? "NONE"}>
              <div className="draft-q-head">
                <span className="q-number" title={t.qNumberTitle} data-testid="q-number">
                  {t.qNumber(i + 1)}
                </span>
                <label className="small">
                  <input type="checkbox" checked={on} onChange={() => toggle(q.id)} data-testid="include" /> {t.include}
                </label>
                <span className={q.outcome === "DIFFERENCE" ? "pill s-FAILED" : "pill warn"}>{cmp.outcomes[q.outcome]}</span>
                {q.audience === "SUPPLIER_OPTIONAL" ? <span className="pill">{t.optional}</span> : null}
                {q.revealsBudget ? <span className="pill warn">{t.revealsBudget}</span> : null}
                {copied !== null ? (
                  <span className="small muted" data-testid="copied-number">
                    {t.copiedAs(copied)}
                  </span>
                ) : (
                  <span className="small unsaved">{t.excluded}</span>
                )}
                {part ? <span className={`pill check-${part.status}`}>{t.partStatus[part.status]}</span> : null}
              </div>
              <p className="small">
                <strong>{t.why}:</strong> {whyText(q).join(" · ")}
              </p>
              <TextPair id={q.id} langs={langs} content={content} initial={initial} onChange={setText} part={part} />
              <div className="draft-q-foot small">
                <a
                  href="#reply-form"
                  title={t.toReplyFormTitle}
                  data-testid="to-reply-form"
                  onClick={(e) => {
                    // Only moves the view: nothing is saved, sent, linked or marked (ReplyTracker focuses its form).
                    e.preventDefault();
                    const detail: ReplyFormPointer = { questionId: q.id, number: i + 1, draftDirty: dirty };
                    window.dispatchEvent(new CustomEvent(REPLY_FORM_EVENT, { detail }));
                  }}
                >
                  {t.toReplyForm}
                </a>
                {content.en.questions[q.id] !== initial.en.questions[q.id] || content.zh.questions[q.id] !== initial.zh.questions[q.id] ? (
                  <button type="button" className="link-button neutral" onClick={() => reset(q.id)}>
                    {t.resetQuestion}
                  </button>
                ) : null}
                <details>
                  <summary>{t.sources}</summary>
                  <ul>
                    {q.origins.map((o) => (
                      <li key={o.key}>
                        <code>{o.key}</code>
                        {o.provisionalPairing ? ` · ${t.proposedPairing}` : ""}
                        <ul>
                          {o.values
                            .filter((v) => v.usedFrom !== null || v.review !== "PENDING")
                            .map((v) => (
                              <li key={`${v.runId}:${v.path}`}>
                                {t.sourceLine(v.path, v.versionNumber, t.review[v.review] ?? v.review)} · run <code>{v.runId.slice(0, 11)}…</code>
                              </li>
                            ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            </article>
          );
        })}
      </section>

      <section className="card" aria-label={t.closing}>
        <h2>{t.closing}</h2>
        <TextPair id="closing" langs={langs} content={content} initial={initial} onChange={setText} part={checkCurrent ? partById.get("closing") : undefined} />
      </section>

      {generated.buyerChecks.length > 0 ? (
        <section className="card" aria-label={t.buyerChecksHeading} data-testid="draft-buyer-checks">
          <h2>{t.buyerChecksHeading}</h2>
          <p className="hint">{t.buyerChecksNote}</p>
          <ul className="small">
            {generated.buyerChecks.map((b) => (
              <li key={b.id} data-buyer-check={b.origin.note.code}>
                <strong>{cmp.fields[b.field] ?? b.field}</strong>
                {b.itemName ? ` — ${b.itemName}` : ""}: {(cmp.notes[b.origin.note.code] ?? (() => b.origin.note.code))(b.origin.note.args)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card check-panel" aria-label={t.checkHeading} data-testid="draft-check" data-check-current={checkCurrent ? "yes" : "no"} data-overall={checkCurrent ? check.overall : "STALE"}>
        <h2>{t.checkHeading}</h2>
        <p className="hint">{t.checkScope}</p>
        <button type="button" onClick={() => setCheck(checkDraft(content, initial))} data-testid="run-check">
          {t.runCheck}
        </button>
        {!checkCurrent ? (
          <p className="small unsaved" data-testid="check-stale">
            {t.checkStale}
          </p>
        ) : (
          <CheckResult check={check} generated={generated} />
        )}
      </section>

      {conflict ? (
        <section className="card alert error-box" data-testid="draft-conflict">
          <p>{t.conflict(conflict.revision)}</p>
          <button type="button" onClick={loadSaved}>
            {t.loadSaved}
          </button>
        </section>
      ) : null}

      {copyAsk ? (
        <section className="card alert warn" role="alertdialog" aria-label={t.copyWarnTitle} data-testid="copy-warning">
          <h2>{t.copyWarnTitle}</h2>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            <li>{t.copyWarnAlways}</li>
          </ul>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void doCopy(copyAsk)} data-testid="copy-anyway">
              {t.copyAnyway} ({LANG_LABEL[copyAsk]})
            </button>
            <button type="button" onClick={() => setCopyAsk(null)}>
              {t.cancel}
            </button>
          </div>
        </section>
      ) : null}

      {fallback ? (
        <section className="card" data-testid="copy-fallback">
          <p className="small">{t.copyFallback}</p>
          <textarea readOnly className="draft-text" rows={12} value={fallback.text} onFocus={(e) => e.currentTarget.select()} lang={fallback.lang === "zh" ? "zh-CN" : "en"} />
        </section>
      ) : null}

      <div className="actions sticky draft-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()} data-testid="save-draft">
          {busy ? t.saving : t.save}
        </button>
        <button type="button" onClick={() => askCopy("en")} data-testid="copy-en">
          {t.copyEn}
        </button>
        <button type="button" onClick={() => askCopy("zh")} data-testid="copy-zh">
          {t.copyZh}
        </button>
        {notice ? (
          <span className={`small ${notice.tone === "error" ? "error" : notice.tone === "warn" ? "unsaved" : ""}`} role="status" data-testid="draft-notice">
            {notice.text}
          </span>
        ) : null}
      </div>
    </>
  );
}

function TextPair({ id, langs, content, initial, onChange, part }: { id: string; langs: Lang[]; content: DraftContent; initial: DraftContent; onChange: (lang: Lang, id: string, v: string) => void; part: PartCheck | undefined }) {
  const value = (c: DraftContent, lang: Lang) => (id === "intro" || id === "closing" ? c[lang][id] : c[lang].questions[id]);
  // One height for the pair: Chinese characters take about twice the width of Latin ones.
  const width = (s: string) => [...s].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
  const rows = Math.min(14, Math.max(3, ...langs.map((l) => value(content, l).split("\n").reduce((n, line) => n + Math.ceil((width(line) + 1) / (langs.length === 2 ? 52 : 100)), 0) + 1)));
  return (
    <div className={langs.length === 2 ? "draft-pair side" : "draft-pair"}>
      {langs.map((lang) => {
        const v = value(content, lang);
        const edited = v !== value(initial, lang);
        const mine = part?.findings.filter((f) => f.lang === lang || f.lang === "both") ?? [];
        return (
          <label key={lang} className="draft-lang" data-lang={lang}>
            <span className="small">
              <strong>{LANG_LABEL[lang]}</strong> {edited ? <span className="pill warn">{t.edited}</span> : null}
            </span>
            <textarea className="draft-text" lang={lang === "zh" ? "zh-CN" : "en"} rows={rows} value={v} onChange={(e) => onChange(lang, id, e.target.value)} data-testid={`text-${lang}`} />
            {mine.length > 0 ? (
              <ul className="small draft-findings">
                {mine.map((f, i) => (
                  <li key={i} data-finding={f.code}>
                    {findingText(f)}
                  </li>
                ))}
              </ul>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

function CheckResult({ check, generated }: { check: DraftCheck; generated: GeneratedDraft }) {
  const label = (id: string) => (id === "intro" ? t.intro : id === "closing" ? t.closing : `${t.qNumber(generated.questions.findIndex((q) => q.id === id) + 1)} · ${(generated.questions.find((q) => q.id === id)?.itemName ?? cmp.fields[generated.questions.find((q) => q.id === id)?.field ?? ""]) || ""}`);
  const n = check.overall === "INCONSISTENT" ? check.counts.INCONSISTENT : check.overall === "REVIEW" ? check.counts.REVIEW : 0;
  const flagged = check.parts.filter((p) => p.status !== "NONE_FOUND");
  return (
    <div data-testid="check-result">
      <p>
        <span className={check.overall === "INCONSISTENT" ? "pill s-FAILED" : check.overall === "REVIEW" ? "pill warn" : "pill"} data-testid="check-overall">
          {t.overall[check.overall](n)}
        </span>
      </p>
      {check.overall === "NONE_FOUND" || check.overall === "REVIEW" ? <p className="small">{t.noneFoundNote}</p> : null}
      {flagged.length > 0 ? (
        <ul className="small">
          {flagged.map((p) => (
            <li key={p.id} data-part={p.id} data-status={p.status}>
              <strong>{t.partStatus[p.status]}</strong> — {label(p.id)}{" "}
              {p.id !== "intro" && p.id !== "closing" ? <a href={`#q-${p.id}`}>{t.goTo}</a> : null}
              <ul>
                {p.findings.map((f, i) => (
                  <li key={i}>{findingText(f)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="hint">{check.rules}</p>
    </div>
  );
}

/** Explicit regeneration: a NEW draft from the current comparison; the old draft and its edits stay as they are. */
export function RegenerateButton({ createUrl, run, baseRun, supersedes }: { createUrl: string; run: string; baseRun: string | null; supersedes: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!window.confirm(t.changed.regenerateConfirm as string)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(createUrl, { method: "POST", headers: { ...csrfHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ run, baseRun, supersedes }), cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { draftId?: string; message?: string } | null;
      if (res.ok && data?.draftId) window.location.assign(window.location.pathname.replace(/[^/]+$/, data.draftId));
      else setError(t.createFailed(data?.message ?? `HTTP ${res.status}`));
    } catch {
      setError(en.editor.outcomeUnknownKeepText);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-testid="regenerate">
      <button type="button" disabled={busy} onClick={() => void go()}>
        {busy ? t.creating : (t.changed.regenerate as string)}
      </button>
      <p className="hint">{t.changed.regenerateNote as string}</p>
      {error ? <p className="small error">{error}</p> : null}
    </div>
  );
}
