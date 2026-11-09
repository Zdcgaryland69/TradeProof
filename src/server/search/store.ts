// Search over requests and quotes (design §3, A3 / A4). Read-only; never calls a model.
//
// Covers: full and short Request ID, TradeProof quote reference (full and QS- short), supplier quote
// numbers in EVERY version of every series (earlier versions, earlier values and AI candidates
// included, each labelled), current request titles and quote names. Request revision contents are not
// searched (owner decision 24 Oct). Quote names have no rename feature, so the current name is the
// stored `quote_series.name`.
//
// One SQL statement per search: a UNION of one branch per matched field (only the branches of the chosen
// category), each yielding ONE row per source record (request, series, or supplier-number row — the joins
// are many-to-one, so nothing is multiplied; DISTINCT guards against duplicates anyway). The access
// scope, category filter and date order are applied before LIMIT; the total is counted separately over
// the same rows, so a capped result never pretends to be complete.
//
// Safety: the query is bound as a parameter. Matching uses instr() / = on keys produced by registered
// deterministic JS functions (tp_search_key, tp_loose_key), so "%", "_", "*", "[" or quotes in the
// query are ordinary characters, never SQL or wildcards.

import type { DatabaseSync } from "node:sqlite";
import {
  CATEGORY_FIELDS,
  SEARCH_LIMITS,
  looseKey,
  searchKey,
  type HitDateMeaning,
  type MatchTier,
  type MatchedField,
  type SearchCategory,
  type SearchHit,
  type SearchResult,
  type SearchSort,
  type SupplierRefStatus,
} from "../../lib/search.ts";
import { requestScope, type Principal } from "../access/policy.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";

type Row = Record<string, unknown>;
type Param = string | number;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FULL_REQUEST = new RegExp(`^pr_${UUID}$`, "i");
const FULL_SERIES = new RegExp(`^qs_${UUID}$`, "i");
const SHORT_REF = /^(PR|QS)[-\s]?([0-9a-f]+)$/i;
const BARE_SHORT = /^[0-9a-f]{8}$/i;

// Uniform columns of every branch.
const REQUEST_COLS = (field: MatchedField, tier: string, value: string) => `
  '${field}' AS field, ${tier} AS tier, ${value} AS matched_value,
  r.id AS r_id, r.title AS r_title, r.created_at AS r_created,
  NULL AS s_id, NULL AS s_name, NULL AS s_supplier,
  NULL AS v_id, NULL AS v_number, NULL AS v_latest, NULL AS v_saved,
  NULL AS q_id, NULL AS q_origin, NULL AS q_created, NULL AS current_user_ref,
  r.updated_at AS sort_at, 'REQUEST_UPDATED' AS date_meaning, '${field}:' || r.id AS stable_id`;
const SERIES_COLS = (field: MatchedField, tier: string, value: string) => `
  '${field}' AS field, ${tier} AS tier, ${value} AS matched_value,
  r.id AS r_id, r.title AS r_title, r.created_at AS r_created,
  s.id AS s_id, s.name AS s_name, s.supplier_display_name AS s_supplier,
  NULL AS v_id, NULL AS v_number, NULL AS v_latest, NULL AS v_saved,
  NULL AS q_id, NULL AS q_origin, NULL AS q_created, NULL AS current_user_ref,
  s.created_at AS sort_at, 'QUOTE_SERIES_CREATED' AS date_meaning, '${field}:' || s.id AS stable_id`;

export interface SearchOptions {
  category?: SearchCategory;
  sort?: SearchSort;
}

export class SearchStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: OpenOptions = {}) {
    this.db = openDatabase(filePath, options);
    this.db.function("tp_search_key", { deterministic: true }, (v: unknown) => (v === null ? null : searchKey(String(v))));
    this.db.function("tp_loose_key", { deterministic: true }, (v: unknown) => (v === null ? null : looseKey(String(v))));
  }

  close(): void {
    this.db.close();
  }

  /** `query` must already be validated (validateSearchQuery). */
  search(principal: Principal, query: string, options: SearchOptions = {}): SearchResult {
    const category = options.category ?? "ALL";
    const sort = options.sort ?? "NEWEST";
    const result: SearchResult = { query, key: searchKey(query), category, sort, hits: [], total: 0, totalRequests: 0, truncated: false, ambiguous: [], notes: [] };
    if (result.key === "") return result;
    const wanted = (field: MatchedField) => category === "ALL" || CATEGORY_FIELDS[category].includes(field);
    const scope = requestScope(principal, "r");
    const branches: { sql: string; params: Param[] }[] = [];
    const nfkc = query.normalize("NFKC").trim();

    // ---- identifiers (full ids exact; short references by prefix on the full id, no LIKE) ----
    if (FULL_REQUEST.test(nfkc) && wanted("REQUEST_ID")) {
      branches.push({ sql: `SELECT ${REQUEST_COLS("REQUEST_ID", "'EXACT'", "r.id")} FROM procurement_requests r WHERE r.id = ? AND (${scope.sql})`, params: [nfkc.toLowerCase(), ...scope.params] });
    }
    if (FULL_SERIES.test(nfkc) && wanted("QUOTE_REFERENCE")) {
      branches.push({
        sql: `SELECT ${SERIES_COLS("QUOTE_REFERENCE", "'EXACT'", "s.id")} FROM quote_series s JOIN procurement_requests r ON r.id = s.request_id WHERE s.id = ? AND (${scope.sql})`,
        params: [nfkc.toLowerCase(), ...scope.params],
      });
    }
    const short = SHORT_REF.exec(nfkc);
    const shortRefs: { kind: "PR" | "QS"; hex: string }[] = [];
    if (short) shortRefs.push({ kind: short[1].toUpperCase() as "PR" | "QS", hex: short[2].toLowerCase() });
    else if (BARE_SHORT.test(nfkc)) shortRefs.push({ kind: "PR", hex: nfkc.toLowerCase() }, { kind: "QS", hex: nfkc.toLowerCase() });
    for (const ref of shortRefs) {
      const field: MatchedField = ref.kind === "PR" ? "REQUEST_SHORT_REF" : "QUOTE_SHORT_REF";
      if (!wanted(field)) continue;
      if (ref.hex.length < SEARCH_LIMITS.minShortRefHex) {
        result.notes.push(`A short reference needs at least ${SEARCH_LIMITS.minShortRefHex} hex digits after ${ref.kind}-.`);
        continue;
      }
      const prefix = (ref.kind === "PR" ? "pr_" : "qs_") + ref.hex;
      branches.push(
        ref.kind === "PR"
          ? { sql: `SELECT ${REQUEST_COLS(field, "'PREFIX'", "r.id")} FROM procurement_requests r WHERE substr(r.id, 1, ?) = ? AND (${scope.sql})`, params: [prefix.length, prefix, ...scope.params] }
          : {
              sql: `SELECT ${SERIES_COLS(field, "'PREFIX'", "s.id")} FROM quote_series s JOIN procurement_requests r ON r.id = s.request_id WHERE substr(s.id, 1, ?) = ? AND (${scope.sql})`,
              params: [prefix.length, prefix, ...scope.params],
            },
      );
    }

    // ---- supplier quote numbers, every version (exact key → contains → labelled similar) ----
    if (wanted("SUPPLIER_QUOTE_NUMBER")) {
      const loose = looseKey(query);
      branches.push({
        sql: `SELECT 'SUPPLIER_QUOTE_NUMBER' AS field,
                     CASE WHEN tp_search_key(q.value_raw) = ? THEN 'EXACT' WHEN instr(tp_search_key(q.value_raw), ?) > 0 THEN 'CONTAINS' ELSE 'SIMILAR' END AS tier,
                     q.value_raw AS matched_value,
                     r.id AS r_id, r.title AS r_title, r.created_at AS r_created,
                     s.id AS s_id, s.name AS s_name, s.supplier_display_name AS s_supplier,
                     v.id AS v_id, v.version_number AS v_number,
                     (SELECT max(version_number) FROM quote_versions WHERE series_id = s.id) AS v_latest, v.saved_at AS v_saved,
                     q.id AS q_id, q.origin AS q_origin, q.created_at AS q_created,
                     (SELECT x.id FROM quote_version_supplier_refs x WHERE x.version_id = v.id AND x.origin <> 'AI_CANDIDATE'
                       ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1) AS current_user_ref,
                     q.created_at AS sort_at, 'SUPPLIER_NUMBER_RECORDED' AS date_meaning, 'SUPPLIER_QUOTE_NUMBER:' || q.id AS stable_id
                FROM quote_version_supplier_refs q
                JOIN quote_versions v ON v.id = q.version_id
                JOIN quote_series s ON s.id = v.series_id
                JOIN procurement_requests r ON r.id = s.request_id
               WHERE q.value_raw IS NOT NULL AND (${scope.sql})
                 AND (instr(tp_search_key(q.value_raw), ?) > 0 OR (length(?) >= 2 AND instr(tp_loose_key(q.value_raw), ?) > 0))`,
        params: [result.key, result.key, ...scope.params, result.key, loose, loose],
      });
    }

    // ---- current request titles and quote names (contains, on the search key) ----
    if (wanted("REQUEST_TITLE")) {
      branches.push({ sql: `SELECT ${REQUEST_COLS("REQUEST_TITLE", "'CONTAINS'", "r.title")} FROM procurement_requests r WHERE instr(tp_search_key(r.title), ?) > 0 AND (${scope.sql})`, params: [result.key, ...scope.params] });
    }
    if (wanted("QUOTE_NAME")) {
      branches.push({
        sql: `SELECT ${SERIES_COLS("QUOTE_NAME", "'CONTAINS'", "s.name")} FROM quote_series s JOIN procurement_requests r ON r.id = s.request_id WHERE instr(tp_search_key(s.name), ?) > 0 AND (${scope.sql})`,
        params: [result.key, ...scope.params],
      });
    }
    if (branches.length === 0) return result;

    const union = `SELECT DISTINCT * FROM (${branches.map((b) => b.sql).join(" UNION ALL ")})`;
    const params = branches.flatMap((b) => b.params);
    const counts = this.db.prepare(`SELECT count(*) AS n, count(DISTINCT r_id) AS requests FROM (${union})`).get(...params) as Row;
    result.total = Number(counts.n);
    result.totalRequests = Number(counts.requests);
    const dir = sort === "OLDEST" ? "ASC" : "DESC";
    const rows = this.db.prepare(`SELECT * FROM (${union}) ORDER BY sort_at ${dir}, stable_id ASC LIMIT ?`).all(...params, SEARCH_LIMITS.maxResults) as Row[];
    result.hits = rows.map((r) => this.toHit(r));
    result.truncated = result.total > result.hits.length;

    // Short codes matching several records: listed (all, up to the limit), never one picked.
    for (const field of ["REQUEST_SHORT_REF", "QUOTE_SHORT_REF"] as const) {
      const n = Number((this.db.prepare(`SELECT count(*) AS n FROM (${union}) WHERE field = ?`).get(...params, field) as Row).n);
      const ref = shortRefs.find((s) => (s.kind === "PR") === (field === "REQUEST_SHORT_REF"));
      if (n > 1 && ref) result.ambiguous.push({ field, prefix: `${ref.kind}-${ref.hex.toUpperCase()}`, count: n });
    }
    return result;
  }

  private toHit(r: Row): SearchHit {
    let supplierRef: SearchHit["supplierRef"] = null;
    if (r.q_id !== null && r.q_id !== undefined) {
      const origin = String(r.q_origin) as "USER_ENTERED" | "AI_CANDIDATE" | "USER_CONFIRMED";
      const status: SupplierRefStatus = origin === "AI_CANDIDATE" ? "CANDIDATE" : r.current_user_ref === r.q_id ? "CURRENT" : "EARLIER";
      supplierRef = { id: String(r.q_id), origin, status, createdAt: String(r.q_created) };
    }
    return {
      matchedField: String(r.field) as MatchedField,
      tier: String(r.tier) as MatchTier,
      matchedValue: String(r.matched_value),
      request: { id: String(r.r_id), title: String(r.r_title), createdAt: String(r.r_created) },
      series: r.s_id !== null && r.s_id !== undefined ? { id: String(r.s_id), name: String(r.s_name), supplierDisplayName: str(r.s_supplier) } : null,
      version: r.v_id !== null && r.v_id !== undefined ? { id: String(r.v_id), versionNumber: Number(r.v_number), latestVersionNumber: Number(r.v_latest), savedAt: String(r.v_saved) } : null,
      supplierRef,
      date: { at: String(r.sort_at), meaning: String(r.date_meaning) as HitDateMeaning },
    };
  }
}
