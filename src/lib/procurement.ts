// Procurement request model shared by the server (validation, storage) and the browser form.
// Pure TypeScript: no Node or React imports, so both sides can use the same limits and types.
// The server is the authority; the browser only uses these for hints and display.

import type { RequestSnapshot } from "./quote-versions.ts";

/** Budget currencies for procurement requests. Budget only — NOT a list of payment currencies. */
export const BUDGET_CURRENCIES = ["USD", "SGD", "CNY"] as const;
export type BudgetCurrency = (typeof BUDGET_CURRENCIES)[number];

/** Only drafts exist in this phase (no approved / paid states). */
export const PROCUREMENT_STATUSES = ["DRAFT"] as const;
export type ProcurementStatus = (typeof PROCUREMENT_STATUSES)[number];

/**
 * Where a request's content came from, recorded once at creation and never changed by edits.
 * Display only: it must not be used for permissions or payment decisions.
 * USER_INPUT = typed / submitted directly; DEMO_SAMPLE = started from "Load demo" (SYNTHETIC sample).
 * `null` = not recorded (requests created before schema v5; not guessed from titles).
 */
export const PROCUREMENT_SOURCES = ["USER_INPUT", "DEMO_SAMPLE"] as const;
export type ProcurementSource = (typeof PROCUREMENT_SOURCES)[number];

/**
 * Who is buying (schema v7). Describes the purchase for display and wording only: it is NOT the PayPal
 * account type and never changes payment permission, PayPal protection eligibility, the payee or any
 * confirmation step. `null` = not recorded (requests created before v7; never inferred from other fields).
 */
export const BUYER_TYPES = ["BUSINESS", "INDIVIDUAL"] as const;
export type BuyerType = (typeof BUYER_TYPES)[number];

/** Server-generated item line id ("pri_<uuid>"). Stable across edits and reordering; never reused. */
export const PROCUREMENT_ITEM_ID = /^pri_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Short reference for people ("PR-79ED0A13"). Display only: the database id never changes. */
export function shortProcurementId(id: string): string {
  return `PR-${id.replace(/^pr_/, "").slice(0, 8).toUpperCase()}`;
}

/** Item reference for people ("IT-1A2B3C4D", first 8 hex of the line id). Display only; copy and APIs use the full id. */
export function shortItemRef(id: string): string {
  return `IT-${id.replace(/^pri_/, "").slice(0, 8).toUpperCase()}`;
}

/** Maximum lengths in characters (Unicode code points), mirrored by CHECKs in the DB schema. */
export const TEXT_LIMITS = {
  title: 200,
  buyerCompany: 200,
  buyerPersonName: 200,
  supplierName: 200,
  shipFrom: 100,
  shipTo: 100,
  paymentTerms: 1000,
  additionalRequirements: 4000,
  itemName: 200,
  itemUnit: 30,
  itemMaterial: 500,
  itemSpecification: 2000,
  itemCustomization: 1000,
  itemNotes: 1000,
} as const;

export const MAX_ITEMS = 50;
/** Whole JSON request body, in bytes (UTF-8). */
export const MAX_BODY_BYTES = 256 * 1024;
/** Largest item quantity (positive whole number). */
export const MAX_QUANTITY = 100_000_000;
/** Largest budget cap: 999,999,999,999.99 → 99,999,999,999,999 minor units (safe integer). */
export const MAX_BUDGET_MINOR = 99_999_999_999_999;
/** Accepted date range for YYYY-MM-DD fields. */
export const MIN_DATE = "2000-01-01";
export const MAX_DATE = "2100-12-31";

/** What the browser sends: every field is text as typed (empty string = not filled in). */
export interface ProcurementItemInput {
  /** Existing line id from the server, or null for a line added in this form (the server assigns one). */
  id: string | null;
  name: string;
  quantity: string;
  unit: string;
  material: string;
  specification: string;
  customization: string;
  notes: string;
}

export interface ProcurementInput {
  title: string;
  /** "BUSINESS" | "INDIVIDUAL", or "" = not recorded (accepted only while the stored value is still not recorded). */
  buyerType: string;
  buyerCompany: string;
  buyerPersonName: string;
  supplierName: string;
  shipFrom: string;
  shipTo: string;
  budgetCurrency: string;
  budgetMax: string;
  requiredShipDate: string;
  expectedDeliveryDate: string;
  paymentTerms: string;
  additionalRequirements: string;
  items: ProcurementItemInput[];
}

/** Stored item line. `null` = not filled in (never silently 0). */
export interface ProcurementItem {
  /** Stable identity of the line (schema v6). */
  id: string;
  /** Display order only (1-based); not an identity. */
  position: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  material: string | null;
  specification: string | null;
  customization: string | null;
  notes: string | null;
}

/** Stored request as returned by the API. Money is integer minor units plus a formatted string. */
export interface ProcurementRecord {
  id: string;
  title: string;
  /** Schema v7. null = not recorded. Display / wording only (see BUYER_TYPES). */
  buyerType: BuyerType | null;
  buyerCompany: string | null;
  /** Schema v7: an individual buyer's name, or a business's contact name. */
  buyerPersonName: string | null;
  supplierName: string | null;
  shipFrom: string | null;
  shipTo: string | null;
  budgetCurrency: BudgetCurrency | null;
  budgetMaxMinor: number | null;
  /** e.g. "1800.00"; null when no cap was entered. */
  budgetMax: string | null;
  requiredShipDate: string | null;
  expectedDeliveryDate: string | null;
  paymentTerms: string | null;
  additionalRequirements: string | null;
  status: ProcurementStatus;
  source: ProcurementSource | null;
  revision: number;
  /** UTC ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  items: ProcurementItem[];
}

export interface ProcurementSummary {
  id: string;
  title: string;
  buyerType: BuyerType | null;
  buyerCompany: string | null;
  buyerPersonName: string | null;
  supplierName: string | null;
  budgetCurrency: BudgetCurrency | null;
  budgetMax: string | null;
  itemCount: number;
  status: ProcurementStatus;
  source: ProcurementSource | null;
  revision: number;
  updatedAt: string;
}

/**
 * One stored revision of a request (schema v8). SAVED = written by the save that created it.
 * MIGRATION_BASELINE = the state that existed when history recording started; earlier revisions of that
 * request were never stored and are shown as unavailable, never reconstructed.
 * There is no sign-in yet, so no "saved by" is recorded or shown.
 */
export interface ProcurementRevisionSummary {
  revision: number;
  origin: "SAVED" | "MIGRATION_BASELINE";
  /** When this revision was saved (the request's updatedAt at that revision), UTC. */
  savedAt: string;
  /** When this history row was written, UTC (= savedAt for SAVED; the migration time for a baseline). */
  archivedAt: string;
  current: boolean;
}

export interface ProcurementRevisionEntry extends ProcurementRevisionSummary {
  snapshotVersion: number;
  snapshot: RequestSnapshot;
}

export interface FieldError {
  /** "title", "budgetMax", "items[0].quantity", "items" … */
  field: string;
  message: string;
}

/** All budget currencies use 2 decimal places. */
export const BUDGET_DECIMALS = 2;

/** 180000 → "1800.00". Integer arithmetic only. */
export function formatBudgetMinor(minor: number): string {
  const base = 10 ** BUDGET_DECIMALS;
  return `${Math.floor(minor / base)}.${String(minor % base).padStart(BUDGET_DECIMALS, "0")}`;
}

export function emptyItem(): ProcurementItemInput {
  return { id: null, name: "", quantity: "", unit: "", material: "", specification: "", customization: "", notes: "" };
}

export function emptyInput(): ProcurementInput {
  return {
    title: "",
    buyerType: "",
    buyerCompany: "",
    buyerPersonName: "",
    supplierName: "",
    shipFrom: "",
    shipTo: "",
    budgetCurrency: "",
    budgetMax: "",
    requiredShipDate: "",
    expectedDeliveryDate: "",
    paymentTerms: "",
    additionalRequirements: "",
    items: [emptyItem()],
  };
}

/** Stored record → form text (null → ""). */
export function recordToInput(record: ProcurementRecord): ProcurementInput {
  const text = (v: string | null) => v ?? "";
  return {
    title: record.title,
    buyerType: text(record.buyerType),
    buyerCompany: text(record.buyerCompany),
    buyerPersonName: text(record.buyerPersonName),
    supplierName: text(record.supplierName),
    shipFrom: text(record.shipFrom),
    shipTo: text(record.shipTo),
    budgetCurrency: text(record.budgetCurrency),
    budgetMax: text(record.budgetMax),
    requiredShipDate: text(record.requiredShipDate),
    expectedDeliveryDate: text(record.expectedDeliveryDate),
    paymentTerms: text(record.paymentTerms),
    additionalRequirements: text(record.additionalRequirements),
    items: record.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity === null ? "" : String(item.quantity),
      unit: text(item.unit),
      material: text(item.material),
      specification: text(item.specification),
      customization: text(item.customization),
      notes: text(item.notes),
    })),
  };
}
