"use client";

// Supplier reply tracking for ONE clarification draft (28 Oct, schema v12; 29 Oct, v13). Loading only reads.
// - A reply is pasted and saved as received, per quote (series). It is never a quote version: it does not become
//   the latest quote and changes no comparison or draft basis. Sender: as typed, not verified.
// - Linking a reply to this draft settles nothing. An answer is the user's reading for one question, with an
//   excerpt that must occur in the reply text; a buyer statement is the user's own reviewed wording, classified as
//   confirming the quoted condition / proposing a new one / unclear — never the supplier's agreement, an approved
//   term or a payment amount. Received, reviewed, quote update and approval are shown as four separate facts.
// - The same text saved again under a new request is a separate reply, flagged as a possible duplicate.
// - If the supplier sent an updated quote, it is saved on the Quotes page as a version; here the user can only
//   record that this reply led to it.
// Every save is append-only and conflict-checked; nothing is sent to the supplier.

import { csrfHeaders } from "@/lib/csrf-client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { shortDraftRef, type DraftQuestion, type GeneratedDraft } from "@/lib/clarification";
import type { AnswerStatus, DraftReplyLink, StatementCheck, StatementKind, StoredAnswer, SupplierReply } from "@/lib/replies";
import { en } from "@/i18n/en";
import type { QuestionReplyState, ReplyView } from "@/server/replies/service";

const t = en.replies;
const cmp = en.comparison;
const utc = en.common.utc;

type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;
type Done = (n: Notice) => void;

/** Sent by a draft question card's "paste the reply" link (DraftEditor): only scrolls to and focuses the reply form. */
export const REPLY_FORM_EVENT = "tradeproof:reply-form";
export interface ReplyFormPointer {
  questionId: string;
  /** The card's Q number in this draft. */
  number: number;
  /** The draft editor had unsaved edits when the link was used (they stay unsaved). */
  draftDirty: boolean;
}

function questionLabel(q: DraftQuestion | undefined): string {
  if (!q) return "";
  const field = cmp.fields[q.field] ?? q.field;
  return q.itemName ? `${field} — ${q.itemName}` : field;
}

type PostData = { code?: string; message?: string; reply?: SupplierReply; possibleDuplicateOf?: string[] } | null;
async function post(url: string, body: unknown): Promise<{ res: Response; data: PostData }> {
  const res = await fetch(url, { method: "POST", headers: { ...csrfHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  return { res, data: (await res.json().catch(() => null)) as PostData };
}

export default function ReplyTracker({
  apiBase,
  seriesApi,
  draftId,
  generated,
  initial,
  quotesHref,
}: {
  apiBase: string;
  seriesApi: string;
  draftId: string;
  generated: GeneratedDraft;
  initial: ReplyView;
  quotesHref: string;
}) {
  const [view, setView] = useState<ReplyView>(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [pointer, setPointer] = useState<(ReplyFormPointer & { seq: number }) | null>(null);

  useEffect(() => {
    let seq = 0;
    const onPointer = (e: Event) => {
      const d = (e as CustomEvent<ReplyFormPointer>).detail;
      if (d && typeof d.questionId === "string") setPointer({ ...d, seq: ++seq });
    };
    window.addEventListener(REPLY_FORM_EVENT, onPointer);
    return () => window.removeEventListener(REPLY_FORM_EVENT, onPointer);
  }, []);

  async function reload(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/replies`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as (ReplyView & { ok: boolean }) | null;
      if (res.ok && data?.ok) setView(data);
    } catch {
      // keep the current view; the notice of the action that triggered the reload stays
    }
  }
  const done: Done = (n) => {
    setNotice(n);
    void reload();
  };

  const linkOf = new Map(view.links.map((l) => [l.id, l] as const));
  const replyNumber = new Map(view.seriesReplies.map((r, i) => [r.id, i + 1] as const));
  const counts = { open: 0, answered: 0, statements: 0 };
  for (const q of view.questions) {
    if (q.state === "STATEMENT_RECORDED") counts.statements += 1;
    if (q.state === "ANSWERED" || q.state === "STATEMENT_RECORDED") counts.answered += 1;
    else counts.open += 1;
  }

  return (
    <section className="card" aria-label={t.heading} data-testid="replies" data-replies={view.seriesReplies.length} data-links={view.links.length}>
      <h2>
        {t.heading} <span lang="zh-CN">{t.headingZh}</span>
      </h2>
      <p className="hint">{t.intro}</p>
      <p className="hint">
        {t.updatedQuoteIntro} <Link href={quotesHref}>Quotes</Link>
      </p>
      <p className="hint">{t.notApproval}</p>
      <p className="hint" data-testid="q-scope">
        {t.scope(shortDraftRef(draftId))}
      </p>

      {view.seriesReplies.length === 0 ? <p className="small muted">{t.noReplies}</p> : null}
      {view.seriesReplies.map((r) => (
        <ReplyCard key={r.id} reply={r} number={replyNumber.get(r.id)!} replyNumber={replyNumber} view={view} generated={generated} apiBase={apiBase} seriesApi={seriesApi} onDone={done} />
      ))}

      <SaveReplyForm
        apiBase={apiBase}
        seriesApi={seriesApi}
        view={view}
        onDone={done}
        draftRef={shortDraftRef(draftId)}
        pointer={pointer}
        pointerLabel={pointer ? questionLabel(generated.questions.find((q) => q.id === pointer.questionId)) : ""}
      />

      <h3>{t.questionsHeading}</h3>
      <p className="small" data-testid="reply-summary">
        {t.summary(counts.open, counts.answered, counts.statements)}
      </p>
      {view.links.length === 0 ? <p className="small muted">{t.noLinks}</p> : null}
      {view.questions.map((s) => (
        <QuestionCard
          key={s.questionId}
          apiBase={apiBase}
          state={s}
          question={generated.questions.find((q) => q.id === s.questionId)}
          links={view.links}
          linkOf={linkOf}
          replyNumber={replyNumber}
          onDone={done}
        />
      ))}
      {notice ? (
        <p className={`small ${notice.tone === "error" ? "error" : notice.tone === "warn" ? "unsaved" : ""}`} role="status" data-testid="reply-notice">
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

function RevisionSelect({ latest, value, onChange, testId }: { latest: number; value: number; onChange: (n: number) => void; testId: string }) {
  return (
    <label className="small">
      {t.sentRevision}{" "}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId}>
        {Array.from({ length: latest }, (_, i) => latest - i).map((n) => (
          <option key={n} value={n}>
            {t.revisionOption(n)}
            {n === latest ? ` (${t.latestMark})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReplyCard({
  reply,
  number,
  replyNumber,
  view,
  generated,
  apiBase,
  seriesApi,
  onDone,
}: {
  reply: SupplierReply;
  number: number;
  replyNumber: Map<string, number>;
  view: ReplyView;
  generated: GeneratedDraft;
  apiBase: string;
  seriesApi: string;
  onDone: Done;
}) {
  const link = view.links.find((l) => l.reply.id === reply.id);
  const [revision, setRevision] = useState(view.latestRevision);
  const [version, setVersion] = useState(view.versions[view.versions.length - 1]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const qn = (id: string) => generated.questions.findIndex((q) => q.id === id) + 1;

  async function linkHere() {
    setBusy(true);
    try {
      const { res, data } = await post(`${apiBase}/replies`, { saveKey: crypto.randomUUID(), reply: reply.id, sentRevision: revision });
      onDone(res.ok ? { tone: "ok", text: t.linked } : { tone: "error", text: t.linkFailed(data?.message ?? `HTTP ${res.status}`) });
    } catch {
      onDone({ tone: "error", text: en.editor.outcomeUnknownKeepText });
    } finally {
      setBusy(false);
    }
  }
  async function linkQuote() {
    setBusy(true);
    try {
      const { res, data } = await post(`${seriesApi}/replies/${reply.id}/quote-links`, { saveKey: crypto.randomUUID(), version });
      onDone(res.ok ? { tone: "ok", text: t.linkQuoteSaved } : { tone: "error", text: t.linkFailed(data?.message ?? `HTTP ${res.status}`) });
    } catch {
      onDone({ tone: "error", text: en.editor.outcomeUnknownKeepText });
    } finally {
      setBusy(false);
    }
  }

  const meta = [
    t.sourceLabel[reply.source] ?? reply.source,
    t.unverified,
    reply.senderAsTyped ? t.senderAs(reply.senderAsTyped) : null,
    reply.receivedOn ? t.receivedLine(reply.receivedOn) : null,
    reply.channelNote,
    t.savedLine(utc(reply.createdAt)),
    reply.fromQuoteVersion ? t.fromVersion(reply.fromQuoteVersion.versionNumber) : null,
    reply.correctsReplyId ? t.correctsLine : null,
  ].filter((x): x is string => !!x);

  return (
    <article className="reply-q" data-testid="reply-card" data-reply={reply.id} data-linked={link ? "yes" : "no"}>
      <p className="small">
        <strong>{t.replyName(number)}</strong> · <span data-testid="reply-meta">{meta.join(" · ")}</span>
      </p>
      {link ? (
        <>
          <p className="small">{t.linkedHere(link.sentRevision, utc(link.createdAt))}</p>
          <p className="small" data-testid="reply-mapping">
            {t.mapping}: {link.sentSelected.map((id, i) => t.mappingLine(i + 1, qn(id))).join(" · ")}
          </p>
        </>
      ) : (
        <div className="reply-q-head small">
          <span className="unsaved">{reply.linkedDraftIds.length === 0 ? t.notLinkedAnywhere : t.notLinkedHere}</span>
          <RevisionSelect latest={view.latestRevision} value={revision} onChange={setRevision} testId="link-revision" />
          <button type="button" disabled={busy} onClick={() => void linkHere()} data-testid="reply-link-here">
            {busy ? t.linking : t.linkHere}
          </button>
        </div>
      )}
      {reply.sameTextAs.length > 0 ? (
        <p className="small unsaved" data-testid="reply-same-text">
          {t.sameText(reply.sameTextAs.map((id) => t.replyName(replyNumber.get(id) ?? 0)).join(", "))}
        </p>
      ) : null}
      {reply.updatedQuotes.length > 0 ? (
        <ul className="small" data-testid="reply-updated-quotes">
          {reply.updatedQuotes.map((q) => (
            <li key={q.id} data-version={q.versionNumber} data-runs={q.finishedRuns}>
              {t.updatedQuoteLine(q.versionNumber, q.finishedRuns)}
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary className="small">{t.showText}</summary>
        <div className="reply-text small" data-testid="reply-text">
          {reply.rawText}
        </div>
      </details>
      {view.versions.length > 0 ? (
        <details className="small">
          <summary>{t.linkQuote}</summary>
          <label>
            {t.linkQuoteChoose}{" "}
            <select value={version} onChange={(e) => setVersion(e.target.value)} data-testid="quote-link-version">
              {view.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {t.versionOption(v.versionNumber, t.kinds[v.contentKind] ?? v.contentKind, utc(v.savedAt))}
                </option>
              ))}
            </select>
          </label>{" "}
          <button type="button" disabled={busy} onClick={() => void linkQuote()} data-testid="quote-link-save">
            {t.linkQuoteSave}
          </button>
        </details>
      ) : null}
    </article>
  );
}

function SaveReplyForm({
  apiBase,
  seriesApi,
  view,
  onDone,
  draftRef,
  pointer,
  pointerLabel,
}: {
  apiBase: string;
  seriesApi: string;
  view: ReplyView;
  onDone: Done;
  draftRef: string;
  pointer: (ReplyFormPointer & { seq: number }) | null;
  pointerLabel: string;
}) {
  const [text, setText] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  const [channel, setChannel] = useState("");
  const [sender, setSender] = useState("");
  const [corrects, setCorrects] = useState("");
  const [linkHere, setLinkHere] = useState(true);
  const [revision, setRevision] = useState(view.latestRevision);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const changed = () => setKey(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Arriving from a question card: show the form and put the cursor in the reply text. Nothing else happens.
  useEffect(() => {
    if (!pointer) return;
    textRef.current?.scrollIntoView({ block: "center" });
    textRef.current?.focus({ preventScroll: true });
  }, [pointer]);

  async function save() {
    // The same content after a lost response → the same key, so the server replays instead of saving twice.
    const saveKey = key ?? crypto.randomUUID();
    setKey(saveKey);
    setBusy(true);
    try {
      const { res, data } = await post(`${seriesApi}/replies`, {
        saveKey,
        rawText: text,
        receivedOn: receivedOn || null,
        channelNote: channel || null,
        senderAsTyped: sender || null,
        correctsReplyId: corrects || null,
      });
      if (!res.ok || !data?.reply) {
        onDone({ tone: "error", text: t.saveFailed(data?.message ?? `HTTP ${res.status}`) });
        return;
      }
      setKey(null);
      setText("");
      setReceivedOn("");
      setChannel("");
      setSender("");
      setCorrects("");
      let message = data.code === "REPLAYED" ? t.replayed : (data.possibleDuplicateOf?.length ?? 0) > 0 ? t.savedPossibleDuplicate : t.saved;
      if (linkHere) {
        const l = await post(`${apiBase}/replies`, { saveKey: crypto.randomUUID(), reply: data.reply.id, sentRevision: revision });
        message += ` ${l.res.ok ? t.linked : t.linkFailed(l.data?.message ?? `HTTP ${l.res.status}`)}`;
      }
      onDone({ tone: (data.possibleDuplicateOf?.length ?? 0) > 0 ? "warn" : "ok", text: message });
    } catch {
      onDone({ tone: "error", text: en.editor.outcomeUnknownKeepText });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reply-form" id="reply-form" data-testid="reply-save-form" data-from-question={pointer?.questionId ?? ""}>
      <h3>{t.saveHeading}</h3>
      <p className="small" data-testid="reply-form-draft">
        {t.formFor(draftRef)}
      </p>
      {pointer ? (
        <div className="small card alert" data-testid="reply-form-pointer" data-question={pointer.questionId}>
          <p>{t.fromQuestion(en.clarification.qNumber(pointer.number), pointerLabel)}</p>
          {pointer.draftDirty ? (
            <p className="unsaved" data-testid="reply-form-draft-unsaved">
              {t.draftUnsaved}
            </p>
          ) : null}
          <a href={`#reply-${pointer.questionId}`}>{t.toQuestion(en.clarification.qNumber(pointer.number))}</a>
        </div>
      ) : null}
      <label className="small">
        {t.rawText}
        <textarea ref={textRef} className="draft-text" rows={5} value={text} onChange={(e) => (setText(e.target.value), changed())} data-testid="reply-raw" />
      </label>
      <label className="small">
        {t.receivedOn} <input type="date" value={receivedOn} onChange={(e) => (setReceivedOn(e.target.value), changed())} data-testid="reply-received" />
      </label>
      <label className="small">
        {t.channel} <input value={channel} maxLength={200} onChange={(e) => (setChannel(e.target.value), changed())} data-testid="reply-channel" />
      </label>
      <label className="small">
        {t.sender} <input value={sender} maxLength={200} onChange={(e) => (setSender(e.target.value), changed())} data-testid="reply-sender" />
      </label>
      {view.seriesReplies.length > 0 ? (
        <label className="small">
          {t.corrects}{" "}
          <select value={corrects} onChange={(e) => (setCorrects(e.target.value), changed())} data-testid="reply-corrects">
            <option value="">{t.correctsNone}</option>
            {view.seriesReplies.map((r, i) => (
              <option key={r.id} value={r.id}>
                {t.replyName(i + 1)} · {utc(r.createdAt)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="small">
        <input type="checkbox" checked={linkHere} onChange={(e) => setLinkHere(e.target.checked)} data-testid="reply-link-after" /> {t.linkAfterSave}
      </label>
      {linkHere ? <RevisionSelect latest={view.latestRevision} value={revision} onChange={setRevision} testId="reply-revision" /> : null}
      <div>
        <button type="button" disabled={busy || text.trim() === ""} onClick={() => void save()} data-testid="reply-save">
          {busy ? t.saving : t.save}
        </button>
      </div>
    </div>
  );
}

function StatementCheckLine({ check }: { check: StatementCheck }) {
  if (check.notInExcerpt.length === 0 && check.unreadable.length === 0) return <p className="small muted">{t.statementCheckNone}</p>;
  return (
    <ul className="small draft-findings" data-testid="statement-check">
      {check.notInExcerpt.length > 0 ? <li>{t.statementCheckMissing(check.notInExcerpt.join(", "))}</li> : null}
      {check.unreadable.length > 0 ? <li>{t.statementCheckUnreadable(check.unreadable.join(", "))}</li> : null}
    </ul>
  );
}

function QuestionCard({
  apiBase,
  state,
  question,
  links,
  linkOf,
  replyNumber,
  onDone,
}: {
  apiBase: string;
  state: QuestionReplyState;
  question: DraftQuestion | undefined;
  links: DraftReplyLink[];
  linkOf: Map<string, DraftReplyLink>;
  replyNumber: Map<string, number>;
  onDone: Done;
}) {
  const [editing, setEditing] = useState(false);
  const latest = state.latest;
  const latestLink = latest ? linkOf.get(latest.replyId) : undefined;
  const newest = links[links.length - 1];
  const inNewest = newest ? (state.copiedIn.find((c) => c.linkId === newest.id)?.number ?? null) : null;
  const replyName = (linkId: string) => {
    const l = linkOf.get(linkId);
    return l ? t.replyName(replyNumber.get(l.reply.id) ?? 0) : "";
  };
  const answered = state.state === "ANSWERED" || state.state === "STATEMENT_RECORDED";

  return (
    <article
      className="reply-q"
      id={`reply-${state.questionId}`}
      data-question={state.questionId}
      data-state={state.state}
      data-basis={latest ? (state.basisCurrent ? "current" : latest.basis ? "changed" : "unknown") : "none"}
      data-contradiction={state.contradictions.length > 0 ? "yes" : "no"}
      data-testid="reply-question"
    >
      <div className="reply-q-head">
        <span className="q-number">{en.clarification.qNumber(state.number)}</span>
        <strong className="small">{questionLabel(question)}</strong>
        {newest ? <span className="small muted">{inNewest !== null ? t.inMessage(inNewest) : t.notSent}</span> : null}
        <span className={answered ? "pill" : "pill warn"} data-testid="reply-state">
          {t.states[state.state]}
        </span>
      </div>
      <ul className="reply-facts small" data-testid="reply-facts">
        <li data-fact="received">{state.replyReceived ? t.facts.received : t.facts.notReceived}</li>
        <li data-fact="reviewed">{latest ? (state.basisCurrent ? t.facts.reviewed : t.facts.reviewedStale) : t.facts.notReviewed}</li>
        <li data-fact="quote" data-value={state.quoteUpdate}>
          {t.facts.quote[state.quoteUpdate]}
        </li>
        <li data-fact="approved">{t.facts.notApproved}</li>
      </ul>
      {question ? (
        <p className="small muted" data-testid="reply-question-text">
          {question.en.length > 160 ? `${question.en.slice(0, 160)}…` : question.en}
        </p>
      ) : null}
      {latest && latestLink ? (
        <div className="small">
          <p className="muted">
            {replyName(latest.replyId)} · {t.latestFrom(utc(latest.createdAt))}
          </p>
          {latest.excerpt ? (
            <>
              <span>{t.excerptLabel}:</span>
              <blockquote className="reply-excerpt" data-testid="reply-excerpt">
                {latest.excerpt}
              </blockquote>
            </>
          ) : null}
          {latest.buyerStatement ? (
            <>
              <p data-testid="reply-statement" data-kind={latest.statementKind ?? "UNCLASSIFIED"}>
                <strong>{t.statementLabel}:</strong> {latest.buyerStatement} <span className="pill">{t.kinds2[latest.statementKind ?? "UNCLASSIFIED"]}</span>
              </p>
              <p className="hint">{t.statementNote}</p>
              {state.statementCheck ? <StatementCheckLine check={state.statementCheck} /> : null}
            </>
          ) : null}
          {latest.note ? <p>{latest.note}</p> : null}
        </div>
      ) : null}
      {state.quoteUpdate === "UPDATED_QUOTE_NEEDED" ? (
        <p className="small unsaved" data-testid="updated-quote-needed">
          {t.updatedQuoteNeeded}
        </p>
      ) : null}
      {state.quoteUpdate === "MANUAL_REVIEW" ? (
        <p className="small unsaved" data-testid="manual-review">
          {t.manualReview}
        </p>
      ) : null}
      {latest && !state.basisCurrent ? (
        <div className="small error" data-testid="basis-warning" data-changes={state.basisChanges.join(" ")}>
          <p>{t.basisChanged}</p>
          <ul>
            {state.basisChanges.map((c) => (
              <li key={c}>{t.basisReasons[c] ?? c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {state.contradictions.length > 0 ? (
        <p className="small error" data-testid="contradiction">
          {t.contradiction(state.contradictions.length)}
        </p>
      ) : null}
      {links.length > 0 && !editing ? (
        <button type="button" className="link-button" onClick={() => setEditing(true)} data-testid="reply-record">
          {latest ? t.edit : t.record}
        </button>
      ) : null}
      {editing ? <AnswerForm apiBase={apiBase} state={state} links={links} replyNumber={replyNumber} onClose={() => setEditing(false)} onDone={onDone} /> : null}
      {state.history.length > 1 ? (
        <details className="small">
          <summary>{t.history(state.history.length)}</summary>
          <ul>
            {[...state.history].reverse().map((h: StoredAnswer) => (
              <li key={h.id}>
                {t.historyLine(utc(h.createdAt), replyName(h.replyId), t.states[h.status === "ANSWERED" && h.buyerStatement ? "STATEMENT_RECORDED" : h.status])}
                {h.buyerStatement ? ` — ${h.buyerStatement}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function AnswerForm({ apiBase, state, links, replyNumber, onClose, onDone }: { apiBase: string; state: QuestionReplyState; links: DraftReplyLink[]; replyNumber: Map<string, number>; onClose: () => void; onDone: Done }) {
  const prev = state.latest;
  const [link, setLink] = useState<string>(links[links.length - 1].id);
  const [status, setStatus] = useState<AnswerStatus>(prev?.status ?? "ANSWERED");
  const [excerpt, setExcerpt] = useState(prev?.excerpt ?? "");
  const [withStatement, setWithStatement] = useState(prev?.buyerStatement != null);
  const [statement, setStatement] = useState(prev?.buyerStatement ?? "");
  const [kind, setKind] = useState<StatementKind | null>(prev?.statementKind ?? null);
  const [note, setNote] = useState(prev?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const changed = () => setKey(null);

  const replyText = links.find((l) => l.id === link)?.reply.rawText ?? "";
  const excerptFound = excerpt.trim() === "" || replyText.includes(excerpt);

  async function save() {
    const k = key ?? crypto.randomUUID();
    setKey(k);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/answers`, {
        method: "POST",
        headers: { ...csrfHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          key: k,
          link,
          question: state.questionId,
          expectedPrevious: prev?.id ?? null,
          status,
          excerpt: status === "NOT_ANSWERED" ? null : excerpt,
          buyerStatement: status === "ANSWERED" && withStatement ? statement : null,
          statementKind: status === "ANSWERED" && withStatement ? kind : null,
          note,
        }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      setKey(null);
      if (res.ok) {
        onClose();
        onDone({ tone: data?.code === "UNCHANGED" ? "warn" : "ok", text: data?.code === "UNCHANGED" ? t.unchanged : data?.code === "REPLAYED" ? t.answerReplayed : t.answerSaved });
      } else if (res.status === 409) {
        onClose();
        onDone({ tone: "error", text: t.conflict });
      } else setError(t.saveFailed(data?.message ?? `HTTP ${res.status}`));
    } catch {
      setError(en.editor.outcomeUnknownKeepText);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reply-form" data-testid="answer-form">
      {links.length > 1 ? (
        <label className="small">
          {t.form.reply}{" "}
          <select value={link} onChange={(e) => (setLink(e.target.value), changed())} data-testid="answer-reply">
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {t.replyName(replyNumber.get(l.reply.id) ?? 0)} · {utc(l.reply.createdAt)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <fieldset className="small">
        <legend>{t.form.status}</legend>
        {(["ANSWERED", "PARTLY_ANSWERED", "NOT_ANSWERED"] as AnswerStatus[]).map((s) => (
          <label key={s}>
            <input type="radio" name={`status-${state.questionId}`} checked={status === s} onChange={() => (setStatus(s), changed())} data-status={s} /> {t.form.statuses[s]}
          </label>
        ))}
      </fieldset>
      {status !== "NOT_ANSWERED" ? (
        <label className="small">
          {t.form.excerpt}
          <textarea className="draft-text" rows={3} maxLength={2000} value={excerpt} onChange={(e) => (setExcerpt(e.target.value), changed())} data-testid="answer-excerpt" />
          {!excerptFound ? <span className="error">{t.excerptNotFound}</span> : null}
        </label>
      ) : null}
      {status === "ANSWERED" ? (
        <>
          <label className="small">
            <input type="checkbox" checked={withStatement} onChange={(e) => (setWithStatement(e.target.checked), changed())} data-testid="answer-add-statement" /> {t.form.addStatement}
          </label>
          {withStatement ? (
            <label className="small">
              {t.form.statement}
              <input value={statement} maxLength={500} onChange={(e) => (setStatement(e.target.value), changed())} data-testid="answer-statement" />
              <span className="hint">{t.statementNote}</span>
            </label>
          ) : null}
          {withStatement ? (
            <fieldset className="small" data-testid="answer-kind">
              <legend>{t.form.kind}</legend>
              {(["CONFIRMS_ORIGINAL", "PROPOSES_NEW", "UNCLEAR"] as StatementKind[]).map((k) => (
                <label key={k}>
                  <input type="radio" name={`kind-${state.questionId}`} checked={kind === k} onChange={() => (setKind(k), changed())} data-kind={k} /> {t.form.kinds[k]}
                </label>
              ))}
            </fieldset>
          ) : null}
        </>
      ) : null}
      <label className="small">
        {t.form.note} <input value={note} maxLength={1000} onChange={(e) => (setNote(e.target.value), changed())} data-testid="answer-note" />
      </label>
      {error ? <p className="small error">{error}</p> : null}
      <div className="actions">
        <button type="button" className="primary" disabled={busy || (withStatement && status === "ANSWERED" && (statement.trim() === "" || kind === null))} onClick={() => void save()} data-testid="answer-save">
          {busy ? t.form.saving : t.form.save}
        </button>
        <button type="button" onClick={onClose}>
          {t.form.cancel}
        </button>
      </div>
    </div>
  );
}
