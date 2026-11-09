// Reading a stored procurement request, and writing its revision snapshot (schema v8).
// No store, no connection handling: functions take an open connection, so the store, the quote store
// and the v8 migration (database.ts) can share them without importing each other.

import type { DatabaseSync } from "node:sqlite";
import { formatBudgetMinor, type BudgetCurrency, type BuyerType, type ProcurementItem, type ProcurementRecord, type ProcurementSource } from "../../lib/procurement.ts";
import { CURRENT_SNAPSHOT_VERSION, type RequestSnapshot } from "../../lib/quote-versions.ts";

type Row = Record<string, unknown>;

function nullableText(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function rowToItem(row: Row): ProcurementItem {
  return {
    id: String(row.id),
    position: Number(row.position),
    name: String(row.name),
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    unit: nullableText(row.unit),
    material: nullableText(row.material),
    specification: nullableText(row.specification),
    customization: nullableText(row.customization),
    notes: nullableText(row.notes),
  };
}

function rowToRecord(row: Row, items: ProcurementItem[]): ProcurementRecord {
  const budgetMaxMinor = row.budget_max_minor === null || row.budget_max_minor === undefined ? null : Number(row.budget_max_minor);
  return {
    id: String(row.id),
    title: String(row.title),
    buyerType: nullableText(row.buyer_type) as BuyerType | null,
    buyerCompany: nullableText(row.buyer_company),
    buyerPersonName: nullableText(row.buyer_person_name),
    supplierName: nullableText(row.supplier_name),
    shipFrom: nullableText(row.ship_from),
    shipTo: nullableText(row.ship_to),
    budgetCurrency: nullableText(row.budget_currency) as BudgetCurrency | null,
    budgetMaxMinor,
    budgetMax: budgetMaxMinor === null ? null : formatBudgetMinor(budgetMaxMinor),
    requiredShipDate: nullableText(row.required_ship_date),
    expectedDeliveryDate: nullableText(row.expected_delivery_date),
    paymentTerms: nullableText(row.payment_terms),
    additionalRequirements: nullableText(row.additional_requirements),
    status: "DRAFT",
    source: nullableText(row.source) as ProcurementSource | null,
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    items,
  };
}

/** Reads one request with its items on any connection (also used inside the quote store's transactions). */
export function readProcurement(db: DatabaseSync, id: string): ProcurementRecord | null {
  const row = db.prepare("SELECT * FROM procurement_requests WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const items = (db.prepare("SELECT * FROM procurement_request_items WHERE request_id = ? ORDER BY position").all(id) as Row[]).map(rowToItem);
  return rowToRecord(row, items);
}

/**
 * SAVED: written in the same transaction as the save that created this revision (business time = archive time).
 * MIGRATION_BASELINE: the state that actually existed when history recording started (schema v8); its
 * business time is the request's own updated_at, its archive time the migration time. Earlier revisions
 * were never stored and are not reconstructed.
 */
export type RevisionOrigin = "SAVED" | "MIGRATION_BASELINE";

/**
 * Stores the request's CURRENT state as the snapshot of its current revision. Must run inside the
 * transaction that produced that state; DB triggers refuse a snapshot of any other revision.
 */
export function recordRevision(db: DatabaseSync, id: string, origin: RevisionOrigin, archivedAt: string): void {
  const record = readProcurement(db, id);
  if (!record) throw new Error("Cannot record the revision of a missing request");
  const snapshot: RequestSnapshot = { snapshotVersion: CURRENT_SNAPSHOT_VERSION, capturedAt: archivedAt, record };
  db.prepare(
    `INSERT INTO procurement_request_revisions (request_id, revision, origin, snapshot_version, snapshot, business_time, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, record.revision, origin, CURRENT_SNAPSHOT_VERSION, JSON.stringify(snapshot), record.updatedAt, archivedAt);
}
