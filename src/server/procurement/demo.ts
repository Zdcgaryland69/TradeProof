// "Load demo" support: maps samples/synthetic/purchase-request.synthetic.json (SYNTHETIC / DEMO,
// fictional) into form text. The sample file is only read, never changed, so the six seeded
// discrepancies in expected-discrepancies.synthetic.json still refer to the same request.
// Nothing is saved here: the browser fills the form and the user decides whether to click Save.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProcurementInput } from "../../lib/procurement.ts";

export const DEMO_SAMPLE_PATH = path.join("samples", "synthetic", "purchase-request.synthetic.json");

interface SampleRequest {
  _notice: string;
  request_id: string;
  buyer: { company: string; contact: string; country: string };
  item: {
    name: string;
    spec: { material: string; capacity_ml: number; color: string; logo: string };
    quantity: number;
    unit: string;
  };
  budget: { currency: string; max_unit_price: number; max_total: number };
  incoterm: string;
  required_ship_date: string;
  payment_terms_accepted: string;
}

/** Fixed 2-decimal text for sample prices (they are written as JSON numbers in the sample). */
function money2(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("Sample budget is not a non-negative number");
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6) throw new Error("Sample budget has more than 2 decimals");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function demoInputFromSample(sample: SampleRequest): ProcurementInput {
  if (!sample._notice.includes("SYNTHETIC")) throw new Error("Demo sample must be marked SYNTHETIC");
  const port = sample.incoterm.replace(/^[A-Z]{3}\s+/, ""); // "FOB Ningbo" → "Ningbo"
  return {
    title: `[SYNTHETIC / DEMO] ${sample.request_id} — ${sample.item.name}`,
    // The sample buyer is a company with a named contact person.
    buyerType: "BUSINESS",
    buyerCompany: sample.buyer.company,
    buyerPersonName: sample.buyer.contact,
    // The sample request names no supplier: left as "to be decided".
    supplierName: "",
    // Derived: FOB Ningbo ships from a port in China; the buyer is in Singapore.
    shipFrom: `China (${sample.incoterm})`,
    shipTo: sample.buyer.country === "SG" ? "Singapore (SG)" : sample.buyer.country,
    budgetCurrency: sample.budget.currency,
    budgetMax: money2(sample.budget.max_total),
    requiredShipDate: sample.required_ship_date,
    // The sample gives a ship-by date, not an arrival date.
    expectedDeliveryDate: "",
    paymentTerms: sample.payment_terms_accepted,
    additionalRequirements: [
      "SYNTHETIC / DEMO DATA — fictional request for TradeProof testing only.",
      `Source: ${DEMO_SAMPLE_PATH.replaceAll("\\", "/")} (${sample.request_id}).`,
      `Incoterm: ${sample.incoterm}; ship by ${sample.required_ship_date} from ${port}.`,
      `Maximum unit price: ${sample.budget.currency} ${money2(sample.budget.max_unit_price)} / ${sample.item.unit}.`,
    ].join("\n"),
    items: [
      {
        id: null,
        name: sample.item.name,
        quantity: String(sample.item.quantity),
        unit: sample.item.unit,
        material: sample.item.spec.material,
        specification: `${sample.item.spec.capacity_ml} ml, ${sample.item.spec.color}`,
        customization: `Logo: ${sample.item.spec.logo}`,
        notes: "SYNTHETIC / DEMO item",
      },
    ],
  };
}

/** Reads the sample at request time (dev only). Returns null if the file is missing or malformed. */
export function loadDemoInput(root: string = process.cwd()): ProcurementInput | null {
  try {
    const sample = JSON.parse(readFileSync(path.join(root, DEMO_SAMPLE_PATH), "utf8")) as SampleRequest;
    return demoInputFromSample(sample);
  } catch {
    return null;
  }
}
