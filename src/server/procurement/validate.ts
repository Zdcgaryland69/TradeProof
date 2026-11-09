// Server-side validation of procurement request input. This is the authority: the browser form
// only mirrors the limits for convenience. Pure functions (no I/O), unit-tested in tests/.
//
// Rules: empty text → null (never 0); quantities are positive whole numbers; budget amounts are
// non-negative decimal strings with at most 2 decimals, converted to integer minor units without
// floating point; dates are calendar-valid YYYY-MM-DD kept as text (no time-zone conversion).

import {
  BUDGET_CURRENCIES,
  BUYER_TYPES,
  BUDGET_DECIMALS,
  MAX_BUDGET_MINOR,
  MAX_DATE,
  MAX_ITEMS,
  MAX_QUANTITY,
  MIN_DATE,
  PROCUREMENT_ITEM_ID,
  TEXT_LIMITS,
  type BudgetCurrency,
  type BuyerType,
  type FieldError,
} from "../../lib/procurement.ts";

export interface NormalizedItem {
  /** Existing line id (checked against the stored record by the store), or null = new line. */
  id: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  material: string | null;
  specification: string | null;
  customization: string | null;
  notes: string | null;
}

export interface NormalizedProcurement {
  title: string;
  /** null = not recorded: refused on create; on update accepted only while the stored value is still null (checked by the store). */
  buyerType: BuyerType | null;
  buyerCompany: string | null;
  buyerPersonName: string | null;
  supplierName: string | null;
  shipFrom: string | null;
  shipTo: string | null;
  budgetCurrency: BudgetCurrency | null;
  budgetMaxMinor: number | null;
  requiredShipDate: string | null;
  expectedDeliveryDate: string | null;
  paymentTerms: string | null;
  additionalRequirements: string | null;
  items: NormalizedItem[];
}

/**
 * `outdatedClient`: an update whose item lines carry no `id` key at all — a page loaded before
 * schema v6. It must not be read as "all lines are new" (that would silently give every line a new
 * identity), so the caller asks the user to refresh instead.
 */
export type ValidationResult = { ok: true; value: NormalizedProcurement } | { ok: false; errors: FieldError[]; outdatedClient?: boolean };

/** "create": item ids must be absent or null. "update": every item must send `id` (string, or null for a new line). */
export type ValidationMode = "create" | "update";

const TOP_LEVEL_FIELDS = new Set([
  "title",
  "buyerType",
  "buyerCompany",
  "buyerPersonName",
  "supplierName",
  "shipFrom",
  "shipTo",
  "budgetCurrency",
  "budgetMax",
  "requiredShipDate",
  "expectedDeliveryDate",
  "paymentTerms",
  "additionalRequirements",
  "items",
]);
const ITEM_FIELDS = new Set(["id", "name", "quantity", "unit", "material", "specification", "customization", "notes"]);

export const OUTDATED_CLIENT_MESSAGE =
  "This page was loaded before an update to how item lines are saved. Nothing was saved. Copy any edits you need, refresh the page, and edit again.";

// C0 control characters other than tab / line feed / carriage return, plus DEL.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** null when `text` is a real YYYY-MM-DD date in MIN_DATE … MAX_DATE, else the message to show. */
export function calendarDateError(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return "Must be a date in YYYY-MM-DD format.";
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Calendar check in UTC so the local time zone can never shift the day.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return "Is not a real calendar date.";
  if (text < MIN_DATE || text > MAX_DATE) return `Must be between ${MIN_DATE} and ${MAX_DATE}.`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Collector {
  readonly errors: FieldError[] = [];
  add(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  /** Optional text: missing / "" / whitespace → null. */
  text(source: Record<string, unknown>, key: string, field: string, max: number, multiline: boolean): string | null {
    const raw = source[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") {
      this.add(field, "Must be text.");
      return null;
    }
    const value = raw.replace(/\r\n?/g, "\n").trim();
    if (value === "") return null;
    if (CONTROL_CHARS.test(value)) {
      this.add(field, "Contains control characters that are not allowed.");
      return null;
    }
    if (!multiline && value.includes("\n")) {
      this.add(field, "Must be a single line.");
      return null;
    }
    const length = [...value].length;
    if (length > max) {
      this.add(field, `Too long: ${length} characters (maximum ${max}).`);
      return null;
    }
    return value;
  }

  quantity(source: Record<string, unknown>, field: string): number | null {
    const raw = source.quantity;
    if (raw === undefined || raw === null) return null;
    let n: number;
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return this.fail(field, "Must be a number.");
      n = raw;
    } else if (typeof raw === "string") {
      const text = raw.trim();
      if (text === "") return null;
      if (/^-\d/.test(text)) return this.fail(field, "Must be greater than 0.");
      if (!/^\d+$/.test(text)) return this.fail(field, "Must be a whole number (digits only), e.g. 500.");
      n = Number(text);
    } else {
      return this.fail(field, "Must be a whole number.");
    }
    if (!Number.isInteger(n)) return this.fail(field, "Must be a whole number.");
    if (n <= 0) return this.fail(field, "Must be greater than 0.");
    if (n > MAX_QUANTITY) return this.fail(field, `Must be at most ${MAX_QUANTITY}.`);
    return n;
  }

  /** "1800.5" → 180050. Strings only, so no floating-point value is ever involved. */
  budget(source: Record<string, unknown>, field: string): number | null {
    const raw = source.budgetMax;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return this.fail(field, 'Send the amount as text, e.g. "1800.00".');
    const text = raw.trim();
    if (text === "") return null;
    if (/^-/.test(text)) return this.fail(field, "Cannot be negative.");
    const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text);
    if (!match) return this.fail(field, "Use digits with an optional decimal point, e.g. 1800.00 (no commas, signs or exponents).");
    const fraction = match[2] ?? "";
    if (fraction.length > BUDGET_DECIMALS) return this.fail(field, `At most ${BUDGET_DECIMALS} decimal places.`);
    const minor = Number(match[1]) * 10 ** BUDGET_DECIMALS + Number(fraction.padEnd(BUDGET_DECIMALS, "0"));
    if (!Number.isSafeInteger(minor) || minor > MAX_BUDGET_MINOR) return this.fail(field, "Amount is too large.");
    return minor;
  }

  date(source: Record<string, unknown>, key: string, field: string): string | null {
    const raw = source[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return this.fail(field, "Must be a date in YYYY-MM-DD format.");
    const text = raw.trim();
    if (text === "") return null;
    const problem = calendarDateError(text);
    return problem ? this.fail(field, problem) : text;
  }

  private fail(field: string, message: string): null {
    this.add(field, message);
    return null;
  }
}

/** Validate and normalise a create/update body (without `revision`). */
export function validateProcurementInput(body: unknown, mode: ValidationMode = "create"): ValidationResult {
  const c = new Collector();
  if (!isRecord(body)) return { ok: false, errors: [{ field: "", message: "Body must be a JSON object." }] };

  for (const key of Object.keys(body)) {
    if (key === "source") c.add(key, "The data source is recorded when the request is created and cannot be changed.");
    else if (!TOP_LEVEL_FIELDS.has(key)) c.add(key, "Unknown field (status, ids and timestamps are set by the server).");
  }

  const title = c.text(body, "title", "title", TEXT_LIMITS.title, false);
  if (title === null && !c.errors.some((e) => e.field === "title")) c.add("title", "Title is required.");

  const buyerCompany = c.text(body, "buyerCompany", "buyerCompany", TEXT_LIMITS.buyerCompany, false);
  const buyerPersonName = c.text(body, "buyerPersonName", "buyerPersonName", TEXT_LIMITS.buyerPersonName, false);
  // Buyer type (v7): wording only, never payment permission. Required for new requests; an old request
  // whose type was never recorded may stay "not recorded" until the user picks one.
  let buyerType: BuyerType | null = null;
  const typeRaw = body.buyerType;
  if (typeRaw !== undefined && typeRaw !== null && typeRaw !== "") {
    if (typeof typeRaw === "string" && (BUYER_TYPES as readonly string[]).includes(typeRaw)) buyerType = typeRaw as BuyerType;
    else c.add("buyerType", "Choose Business or Individual.");
  } else if (mode === "create") {
    c.add("buyerType", "Choose Business or Individual.");
  }
  if (buyerType === "BUSINESS" && buyerCompany === null && !c.errors.some((e) => e.field === "buyerCompany")) {
    c.add("buyerCompany", "Company name is required for a business buyer.");
  }
  if (buyerType === "INDIVIDUAL" && buyerPersonName === null && !c.errors.some((e) => e.field === "buyerPersonName")) {
    c.add("buyerPersonName", "Your name is required for an individual buyer.");
  }
  const supplierName = c.text(body, "supplierName", "supplierName", TEXT_LIMITS.supplierName, false);
  const shipFrom = c.text(body, "shipFrom", "shipFrom", TEXT_LIMITS.shipFrom, false);
  const shipTo = c.text(body, "shipTo", "shipTo", TEXT_LIMITS.shipTo, false);

  let budgetCurrency: BudgetCurrency | null = null;
  const currencyRaw = body.budgetCurrency;
  if (currencyRaw !== undefined && currencyRaw !== null && currencyRaw !== "") {
    if (typeof currencyRaw === "string" && (BUDGET_CURRENCIES as readonly string[]).includes(currencyRaw)) {
      budgetCurrency = currencyRaw as BudgetCurrency;
    } else {
      c.add("budgetCurrency", `Must be one of ${BUDGET_CURRENCIES.join(", ")}.`);
    }
  }
  const budgetMaxMinor = c.budget(body, "budgetMax");
  if (budgetMaxMinor !== null && budgetCurrency === null && !c.errors.some((e) => e.field === "budgetCurrency")) {
    c.add("budgetCurrency", "Choose the currency of the budget cap.");
  }

  const requiredShipDate = c.date(body, "requiredShipDate", "requiredShipDate");
  const expectedDeliveryDate = c.date(body, "expectedDeliveryDate", "expectedDeliveryDate");
  const paymentTerms = c.text(body, "paymentTerms", "paymentTerms", TEXT_LIMITS.paymentTerms, true);
  const additionalRequirements = c.text(body, "additionalRequirements", "additionalRequirements", TEXT_LIMITS.additionalRequirements, true);

  const items: NormalizedItem[] = [];
  const seenIds = new Set<string>();
  let outdatedClient = false;
  const rawItems = body.items;
  if (!Array.isArray(rawItems)) {
    c.add("items", "Add at least one item with a name.");
  } else if (rawItems.length === 0) {
    c.add("items", "Add at least one item with a name.");
  } else if (rawItems.length > MAX_ITEMS) {
    c.add("items", `At most ${MAX_ITEMS} items per request.`);
  } else {
    rawItems.forEach((raw, i) => {
      const at = (f: string) => `items[${i}].${f}`;
      if (!isRecord(raw)) {
        c.add(`items[${i}]`, "Each item must be an object.");
        return;
      }
      for (const key of Object.keys(raw)) {
        if (!ITEM_FIELDS.has(key)) c.add(at(key), "Unknown field.");
      }
      let id: string | null = null;
      if (mode === "update" && !("id" in raw)) {
        outdatedClient = true;
      } else if (raw.id !== undefined && raw.id !== null) {
        if (mode === "create") c.add(at("id"), "A new request cannot reference existing item lines.");
        else if (typeof raw.id !== "string" || !PROCUREMENT_ITEM_ID.test(raw.id)) c.add(at("id"), "Not a valid item id.");
        else if (seenIds.has(raw.id)) c.add(at("id"), "The same item line appears twice.");
        else {
          seenIds.add(raw.id);
          id = raw.id;
        }
      }
      const name = c.text(raw, "name", at("name"), TEXT_LIMITS.itemName, false);
      if (name === null && !c.errors.some((e) => e.field === at("name"))) c.add(at("name"), "Item name is required.");
      const item: NormalizedItem = {
        id,
        name: name ?? "",
        quantity: c.quantity(raw, at("quantity")),
        unit: c.text(raw, "unit", at("unit"), TEXT_LIMITS.itemUnit, false),
        material: c.text(raw, "material", at("material"), TEXT_LIMITS.itemMaterial, true),
        specification: c.text(raw, "specification", at("specification"), TEXT_LIMITS.itemSpecification, true),
        customization: c.text(raw, "customization", at("customization"), TEXT_LIMITS.itemCustomization, true),
        notes: c.text(raw, "notes", at("notes"), TEXT_LIMITS.itemNotes, true),
      };
      items.push(item);
    });
  }

  if (outdatedClient) {
    return { ok: false, outdatedClient: true, errors: [{ field: "items", message: OUTDATED_CLIENT_MESSAGE }] };
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return {
    ok: true,
    value: {
      title: title!,
      buyerType,
      buyerCompany,
      buyerPersonName,
      supplierName,
      shipFrom,
      shipTo,
      budgetCurrency,
      budgetMaxMinor,
      requiredShipDate,
      expectedDeliveryDate,
      paymentTerms,
      additionalRequirements,
      items,
    },
  };
}
