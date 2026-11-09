import type { Metadata } from "next";
import Link from "next/link";
import { shortProcurementId } from "@/lib/procurement";
import { en } from "@/i18n/en";
import { parseCategory, parseSort, validateSearchQuery } from "@/lib/search";
import { requestScope, type Principal } from "@/server/access/policy";
import { getProcurementStore } from "@/server/procurement";
import { getSearchStore } from "@/server/search";
import { requireSignedInPage } from "./local-only";
import { SearchBox, SearchResults, type SearchState } from "./SearchResults";
import { SourceTag } from "./SourceTag";

export const metadata: Metadata = {
  title: "Procurement requests — TradeProof",
  robots: { index: false, follow: false },
};

const t = en.list;

function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export default async function ProcurementListPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireSignedInPage("/procurements");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const raw = (one(params.q) ?? "").slice(0, 4_000);
  const category = parseCategory(one(params.field));
  const sort = parseSort(one(params.sort));
  let search: SearchState = { kind: "none" };
  const checked = validateSearchQuery(raw);
  if (!checked.ok) search = { kind: "invalid", query: raw, message: checked.message };
  else if (!category || !sort) search = { kind: "invalid", query: raw, message: "Unknown search field or sort order." };
  else if (checked.query !== "") {
    try {
      search = { kind: "done", result: getSearchStore().search(me, checked.query, { category, sort }) };
    } catch {
      search = { kind: "error", query: raw };
    }
  }

  return (
    <main className="page wide">
      <p className="crumbs">
        <Link href="/">TradeProof</Link> / {t.title}
      </p>
      <h1>{t.title}</h1>
      <p className="tagline">
        {t.tagline}
        <span className="zh">{t.taglineZh}</span>
      </p>
      <p className="note small">{t.note}</p>
      <div className="actions">
        <Link className="button primary" href="/procurements/new">
          {t.newRequest}
        </Link>
      </div>

      <SearchBox value={raw} category={category ?? "ALL"} sort={sort ?? "NEWEST"} active={search.kind !== "none"} />
      {/* While a search is active only its results are shown, never the unfiltered list below. */}
      {search.kind !== "none" ? <SearchResults state={search} /> : <RequestList me={me} />}
    </main>
  );
}

function RequestList({ me }: { me: Principal }) {
  const requests = getProcurementStore().list(100, requestScope(me, "r"));
  return (
    <>

      {requests.length === 0 ? (
        <div className="card empty" role="status">
          <h2>{t.emptyTitle}</h2>
          <p className="muted">
            Create one, or open <Link href="/procurements/new">New request</Link> and press <strong>Load demo</strong> to fill the
            form with the SYNTHETIC sample.
          </p>
        </div>
      ) : (
        <ul className="request-list">
          {requests.map((r) => (
            <li key={r.id} className="card">
              <Link href={`/procurements/${r.id}`} className="request-title">
                {r.title}
              </Link>
              <p className="small muted">
                <strong className="ref">{shortProcurementId(r.id)}</strong> · <span className="pill">{r.status}</span>{" "}
                <SourceTag source={r.source} /> rev {r.revision} · {t.items(r.itemCount)} · {t.buyer}:{" "}
                <span className={r.buyerType === null ? "pill source-unknown" : "pill"}>{en.buyer.listLabel(r.buyerType)}</span>{" "}
                {(r.buyerType === "INDIVIDUAL" ? r.buyerPersonName : r.buyerCompany) ?? "—"} · {t.supplier}: {r.supplierName ?? t.supplierTbd} · {t.budgetCap}:{" "}
                {r.budgetMax === null ? "—" : `${r.budgetCurrency} ${r.budgetMax}`} · {t.updated} {utc(r.updatedAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
