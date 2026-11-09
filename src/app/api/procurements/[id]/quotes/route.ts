import { getAuthGate } from "@/server/auth";
import { procurementEnabled } from "@/server/procurement";
import { getQuoteStore } from "@/server/quotes";
import { handleCreateSeries, handleListQuotes } from "@/server/quotes/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleListQuotes(req, id, getQuoteStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCreateSeries(req, id, getQuoteStore, { enabled: procurementEnabled(), auth: getAuthGate() });
}
