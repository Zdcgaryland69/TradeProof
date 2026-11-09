import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getSearchStore } from "@/server/search";
import { handleSearch } from "@/server/search/http";

export async function GET(req: Request) {
  return handleSearch(req, getSearchStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
