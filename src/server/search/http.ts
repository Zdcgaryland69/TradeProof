// GET /api/procurements/search?q=…&field=<category>&sort=NEWEST|OLDEST (local dev only; same guard as the other procurement APIs).
// 200 { ok, query, key, category, sort, hits, total, totalRequests, truncated, ambiguous, notes } · 422 INVALID_QUERY (input echoed back) ·
// production → 404 · non-loopback Host → 403. Read-only; never calls a model.

import { SEARCH_CATEGORIES, SEARCH_SORTS, parseCategory, parseSort, validateSearchQuery } from "../../lib/search.ts";
import { guard, type GuardOptions } from "../auth/gate.ts";
import type { SearchStore } from "./store.ts";

export type SearchSource = SearchStore | (() => SearchStore);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleSearch(req: Request, source: SearchSource, opts: GuardOptions): Promise<Response> {
  const who = guard(req, opts, "Search API");
  if (who instanceof Response) return who;
  const url = new URL(req.url);
  const raw = url.searchParams.get("q") ?? "";
  const category = parseCategory(url.searchParams.get("field"));
  const sort = parseSort(url.searchParams.get("sort"));
  if (!category) return json(422, { ok: false, code: "INVALID_QUERY", message: `field must be one of ${SEARCH_CATEGORIES.join(", ")}.`, query: raw });
  if (!sort) return json(422, { ok: false, code: "INVALID_QUERY", message: `sort must be one of ${SEARCH_SORTS.join(", ")}.`, query: raw });
  if (raw.length > 4_000) return json(422, { ok: false, code: "INVALID_QUERY", message: "Search text is limited to 200 characters." });
  const checked = validateSearchQuery(raw);
  if (!checked.ok) return json(422, { ok: false, code: "INVALID_QUERY", message: checked.message, query: raw });
  const store = typeof source === "function" ? source() : source;
  return json(200, { ok: true, ...store.search(who, checked.query, { category, sort }) });
}
