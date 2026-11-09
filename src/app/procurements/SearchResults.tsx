// Search box and results for the request list (server-rendered from ?q=&field=&sort=; a plain GET form,
// so no client code is needed and the choices stay in the form and the URL). While a search is active the
// page shows ONLY this results area — never the unfiltered request list. Strings: src/i18n/en.ts.

import Link from "next/link";
import { shortProcurementId } from "@/lib/procurement";
import { shortSeriesId } from "@/lib/quote-versions";
import { SEARCH_CATEGORIES, SEARCH_LIMITS, SEARCH_SORTS, type SearchCategory, type SearchHit, type SearchResult, type SearchSort } from "@/lib/search";
import { en } from "@/i18n/en";

const t = en.search;

export type SearchState =
  | { kind: "none" }
  | { kind: "invalid"; query: string; message: string }
  | { kind: "error"; query: string }
  | { kind: "done"; result: SearchResult };

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function SearchBox({ value, category, sort, active }: { value: string; category: SearchCategory; sort: SearchSort; active: boolean }) {
  return (
    <form method="get" action="/procurements" role="search" className="search-box card" aria-label={t.label}>
      <label htmlFor="q" className="small">
        {t.label}
      </label>
      <div className="actions">
        <input id="q" name="q" type="search" defaultValue={value} maxLength={SEARCH_LIMITS.maxQueryChars} placeholder={t.placeholder} autoComplete="off" />
      </div>
      <div className="actions">
        <label className="small">
          {t.categoryLabel}{" "}
          <select name="field" defaultValue={category} data-testid="search-field">
            {SEARCH_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t.categories[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          {t.sortLabel}{" "}
          <select name="sort" defaultValue={sort} data-testid="search-sort">
            {SEARCH_SORTS.map((s) => (
              <option key={s} value={s}>
                {t.sorts[s]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          {t.submit}
        </button>
        {active ? (
          <Link className="button" href="/procurements" data-testid="clear-search">
            {t.clear}
          </Link>
        ) : null}
      </div>
      <p className="hint">{t.scope}</p>
    </form>
  );
}

function hitHref(h: SearchHit): string {
  if (h.series && h.version) return `/procurements/${h.request.id}/quotes?series=${h.series.id}&version=${h.version.id}`;
  if (h.series) return `/procurements/${h.request.id}/quotes?series=${h.series.id}`;
  return `/procurements/${h.request.id}`;
}

export function SearchResults({ state }: { state: SearchState }) {
  if (state.kind === "none") return null;
  if (state.kind === "invalid") {
    return (
      <p className="card alert error-box" role="alert" data-testid="search-invalid">
        {t.invalid(state.message)}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="card alert error-box" role="alert">
        {t.failed}
      </p>
    );
  }
  const r = state.result;
  const category = t.categories[r.category];
  return (
    <section className="search-results" aria-label={t.activeTitle} data-testid="search-results" data-total={r.total} data-total-requests={r.totalRequests}>
      <h2>{t.activeTitle}</h2>
      {r.hits.length === 0 ? (
        <p className="card empty" role="status" data-testid="search-empty">
          {t.noResults(r.query, category)}
        </p>
      ) : (
        <>
          <p className="small" role="status" data-testid="search-count">
            <strong>{t.matches(r.total, r.totalRequests, r.query, category)}</strong> · {t.sorts[r.sort]}
          </p>
          <p className="hint">
            {t.unitNote} {t.dateHint} <span className="muted">{t.notIsolation}</span>
          </p>
        </>
      )}
      {r.truncated ? (
        <p className="alert warn small" role="note" data-testid="search-truncated">
          {t.truncatedOf(r.hits.length, r.total)}
        </p>
      ) : null}
      {r.notes.map((n) => (
        <p key={n} className="small muted">
          {n}
        </p>
      ))}
      {r.ambiguous.map((a) => (
        <p key={a.prefix} className="alert warn small" role="note" data-testid="search-ambiguous">
          {t.ambiguous(a.prefix, a.count)}
        </p>
      ))}
      <ul className="request-list">
        {r.hits.map((h) => (
          <li key={`${h.matchedField}-${h.supplierRef?.id ?? h.series?.id ?? h.request.id}`} className="card" data-field={h.matchedField} data-tier={h.tier} data-date={h.date.at}>
            <p className="small">
              <strong>{t.fields[h.matchedField]}</strong> · {t.tiers[h.tier]}: <code className="pre">{h.matchedValue}</code>
              {h.supplierRef ? (
                <>
                  {" "}
                  · <span className={h.supplierRef.origin === "AI_CANDIDATE" ? "pill warn" : "pill"}>{t.origins[h.supplierRef.origin]}</span>{" "}
                  <span className="muted">({t.statuses[h.supplierRef.status]})</span>
                </>
              ) : null}
              {" · "}
              <span className="muted">
                {when(h.date.at)} ({t.dateMeanings[h.date.meaning]})
              </span>
            </p>
            <p className="small muted">
              {t.context}: <strong className="ref">{shortProcurementId(h.request.id)}</strong> {h.request.title}
              {h.series ? (
                <>
                  {" "}
                  → <strong className="ref">{shortSeriesId(h.series.id)}</strong> {h.series.name} · {t.supplier(h.series.supplierDisplayName)}
                </>
              ) : null}
              {h.version ? <> → {t.version(h.version.versionNumber, h.version.latestVersionNumber)}</> : null}
            </p>
            <Link href={hitHref(h)} className="small">
              {h.version ? t.openVersion : h.series ? t.openQuote : t.openRequest}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
