// Procurement request store on the shared local SQLite file (tables from schema v4, item ids v6).
// A request and its items are always written in one transaction. Updates are compare-and-set on
// `revision` (optimistic concurrency): a save based on an older revision changes nothing and
// reports a conflict. Since schema v8 every revision a save creates is also stored as an immutable
// snapshot (procurement_request_revisions) in the same transaction; a save that changes nothing writes
// nothing. Quote versions keep their own, separate snapshot of the request they were saved against.
// Item lines keep their server-generated id across edits and reordering; `position` is display order.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  formatBudgetMinor,
  type FieldError,
  type BudgetCurrency,
  type BuyerType,
  type ProcurementRecord,
  type ProcurementSource,
  type ProcurementSummary,
} from "../../lib/procurement.ts";
import type { ProcurementRevisionEntry, ProcurementRevisionSummary } from "../../lib/procurement.ts";
import type { RequestSnapshot } from "../../lib/quote-versions.ts";
import { openDatabase, type OpenOptions } from "../db/database.ts";
import { readProcurement, recordRevision, type RevisionOrigin } from "./records.ts";
import type { NormalizedProcurement } from "./validate.ts";

export { readProcurement } from "./records.ts";

export const PROCUREMENT_ID = /^pr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = Record<string, unknown>;

export type UpdateOutcome =
  | { status: "UPDATED"; record: ProcurementRecord }
  /** Nothing differs from the stored record: nothing was written (same revision, same updated_at, no history row). */
  | { status: "NO_CHANGES"; record: ProcurementRecord }
  | { status: "CONFLICT"; current: ProcurementRecord }
  | { status: "INVALID_ITEMS"; errors: FieldError[] }
  | { status: "NOT_FOUND" };

export const BUYER_TYPE_CLEARED_MESSAGE = "The buyer type is already recorded and cannot be removed. Choose Business or Individual.";

export const FOREIGN_ITEM_MESSAGE =
  "This item line is not part of this request (it may have been removed in another tab). Nothing was saved. Load the latest version and edit again.";

function nullableText(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * True when saving `input` would not change anything the user can see or rely on: every business field
 * and every item line (full id, content and order) equal the stored record. Values are compared after the
 * same validation / normalisation the save would apply (trim, CR LF → LF, empty → null); case, inner
 * spaces and any other text difference count as a change.
 */
export function sameAsStored(current: ProcurementRecord, input: NormalizedProcurement): boolean {
  const fields = ["title", "buyerType", "buyerCompany", "buyerPersonName", "supplierName", "shipFrom", "shipTo", "budgetCurrency", "budgetMaxMinor", "requiredShipDate", "expectedDeliveryDate", "paymentTerms", "additionalRequirements"] as const;
  if (fields.some((f) => current[f] !== input[f])) return false;
  if (current.items.length !== input.items.length) return false;
  const itemFields = ["id", "name", "quantity", "unit", "material", "specification", "customization", "notes"] as const;
  return input.items.every((item, i) => itemFields.every((f) => current.items[i][f] === item[f]));
}

export class ProcurementStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(filePath: string, options: OpenOptions & { now?: () => Date } = {}) {
    this.db = openDatabase(filePath, options);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT; any error rolls the whole write back. */
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Brings the stored lines to `input.items` (the caller has checked every non-null id belongs to `id`):
   * lines whose id is not submitted are deleted, lines with an id are updated in place (id unchanged,
   * new position), lines with id null are inserted with a fresh random id. Ids are never reused.
   */
  private writeItems(id: string, input: NormalizedProcurement): void {
    const keep = new Set(input.items.map((i) => i.id).filter((v): v is string => v !== null));
    const existing = (this.db.prepare("SELECT id FROM procurement_request_items WHERE request_id = ?").all(id) as Row[]).map((r) => String(r.id));
    const remove = this.db.prepare("DELETE FROM procurement_request_items WHERE id = ? AND request_id = ?");
    for (const itemId of existing) if (!keep.has(itemId)) remove.run(itemId, id);
    // Move kept lines out of the way first so UNIQUE(request_id, position) holds while reordering.
    this.db.prepare("UPDATE procurement_request_items SET position = position + 1000000 WHERE request_id = ?").run(id);
    const update = this.db.prepare(
      `UPDATE procurement_request_items
          SET position = ?, name = ?, quantity = ?, unit = ?, material = ?, specification = ?, customization = ?, notes = ?
        WHERE id = ? AND request_id = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO procurement_request_items
         (id, request_id, position, name, quantity, unit, material, specification, customization, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.items.forEach((item, index) => {
      const fields = [item.name, item.quantity, item.unit, item.material, item.specification, item.customization, item.notes] as const;
      if (item.id === null) {
        insert.run(`pri_${randomUUID()}`, id, index + 1, ...fields);
      } else if (Number(update.run(index + 1, ...fields, item.id, id).changes) !== 1) {
        throw new Error("Item line vanished during save"); // rolls the whole transaction back
      }
    });
  }

  /**
   * `source` is recorded once here; `update` never changes it. `ownerId` (schema v15) = the signed-in buyer who
   * creates it: the ownership row is written in the same transaction, so a request never exists without its owner
   * when created through the app. Without an owner (old scripts, tests) the request is visible to nobody.
   */
  create(input: NormalizedProcurement, source: ProcurementSource, ownerId: string | null = null, ownerSource: "CREATED_BY_BUYER" | "OPERATOR_SEED" = "CREATED_BY_BUYER"): ProcurementRecord {
    const id = `pr_${randomUUID()}`;
    const nowIso = this.now().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO procurement_requests
             (id, title, buyer_type, buyer_company, buyer_person_name, supplier_name, ship_from, ship_to, budget_currency, budget_max_minor,
              required_ship_date, expected_delivery_date, payment_terms, additional_requirements,
              status, source, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.buyerType,
          input.buyerCompany,
          input.buyerPersonName,
          input.supplierName,
          input.shipFrom,
          input.shipTo,
          input.budgetCurrency,
          input.budgetMaxMinor,
          input.requiredShipDate,
          input.expectedDeliveryDate,
          input.paymentTerms,
          input.additionalRequirements,
          source,
          nowIso,
          nowIso,
        );
      this.writeItems(id, input);
      recordRevision(this.db, id, "SAVED", nowIso);
      if (ownerId) {
        this.db.prepare("INSERT INTO procurement_owners (request_id, principal_id, source, created_at) VALUES (?, ?, ?, ?)").run(id, ownerId, ownerSource, nowIso);
      }
    });
    return this.get(id)!;
  }

  /** Save only if the stored revision is still `baseRevision`; otherwise report the newer version. */
  update(id: string, baseRevision: number, input: NormalizedProcurement): UpdateOutcome {
    const nowIso = this.now().toISOString();
    let itemErrors: FieldError[] = [];
    const outcome = this.transaction((): "UPDATED" | "NO_CHANGES" | "CONFLICT" | "NOT_FOUND" | "INVALID_ITEMS" => {
      const current = this.db.prepare("SELECT revision, buyer_type FROM procurement_requests WHERE id = ?").get(id) as Row | undefined;
      if (!current) return "NOT_FOUND";
      if (Number(current.revision) !== baseRevision) return "CONFLICT";
      // "Not recorded" may stay so on old requests, but a recorded buyer type is never silently dropped.
      if (current.buyer_type !== null && input.buyerType === null) {
        itemErrors = [{ field: "buyerType", message: BUYER_TYPE_CLEARED_MESSAGE }];
        return "INVALID_ITEMS";
      }
      // Every submitted id must be a line of THIS request now: not another request's, not a removed one.
      const owned = new Set((this.db.prepare("SELECT id FROM procurement_request_items WHERE request_id = ?").all(id) as Row[]).map((r) => String(r.id)));
      itemErrors = input.items.flatMap((item, i) =>
        item.id !== null && !owned.has(item.id) ? [{ field: `items[${i}].id`, message: FOREIGN_ITEM_MESSAGE }] : [],
      );
      if (itemErrors.length > 0) return "INVALID_ITEMS";
      // Checked after the revision check, so a stale page still gets a conflict, never "no changes".
      if (sameAsStored(readProcurement(this.db, id)!, input)) return "NO_CHANGES";
      const result = this.db
        .prepare(
          `UPDATE procurement_requests SET
             title = ?, buyer_type = ?, buyer_company = ?, buyer_person_name = ?, supplier_name = ?, ship_from = ?, ship_to = ?,
             budget_currency = ?, budget_max_minor = ?, required_ship_date = ?, expected_delivery_date = ?,
             payment_terms = ?, additional_requirements = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          input.title,
          input.buyerType,
          input.buyerCompany,
          input.buyerPersonName,
          input.supplierName,
          input.shipFrom,
          input.shipTo,
          input.budgetCurrency,
          input.budgetMaxMinor,
          input.requiredShipDate,
          input.expectedDeliveryDate,
          input.paymentTerms,
          input.additionalRequirements,
          nowIso,
          id,
          baseRevision,
        );
      if (Number(result.changes) !== 1) {
        const exists = this.db.prepare("SELECT 1 FROM procurement_requests WHERE id = ?").get(id);
        return exists ? "CONFLICT" : "NOT_FOUND";
      }
      this.writeItems(id, input);
      recordRevision(this.db, id, "SAVED", nowIso);
      return "UPDATED";
    });
    if (outcome === "NOT_FOUND") return { status: "NOT_FOUND" };
    if (outcome === "INVALID_ITEMS") return { status: "INVALID_ITEMS", errors: itemErrors };
    const record = this.get(id)!;
    if (outcome === "NO_CHANGES") return { status: "NO_CHANGES", record };
    return outcome === "UPDATED" ? { status: "UPDATED", record } : { status: "CONFLICT", current: record };
  }

  /** Stored revisions, newest first. Empty for an unknown request. */
  revisions(id: string): ProcurementRevisionSummary[] {
    const current = this.db.prepare("SELECT revision FROM procurement_requests WHERE id = ?").get(id) as Row | undefined;
    if (!current) return [];
    return (this.db.prepare("SELECT revision, origin, business_time, archived_at FROM procurement_request_revisions WHERE request_id = ? ORDER BY revision DESC").all(id) as Row[]).map((r) => ({
      revision: Number(r.revision),
      origin: String(r.origin) as RevisionOrigin,
      savedAt: String(r.business_time),
      archivedAt: String(r.archived_at),
      current: Number(r.revision) === Number(current.revision),
    }));
  }

  /** One stored revision with its full snapshot (read from the history table only, never from current items). */
  revision(id: string, revision: number): ProcurementRevisionEntry | null {
    const r = this.db.prepare("SELECT * FROM procurement_request_revisions WHERE request_id = ? AND revision = ?").get(id, revision) as Row | undefined;
    if (!r) return null;
    const current = this.db.prepare("SELECT revision FROM procurement_requests WHERE id = ?").get(id) as Row;
    return {
      revision: Number(r.revision),
      origin: String(r.origin) as RevisionOrigin,
      savedAt: String(r.business_time),
      archivedAt: String(r.archived_at),
      current: Number(r.revision) === Number(current.revision),
      snapshotVersion: Number(r.snapshot_version),
      snapshot: JSON.parse(String(r.snapshot)) as RequestSnapshot,
    };
  }

  get(id: string): ProcurementRecord | null {
    return readProcurement(this.db, id);
  }

  /** Requests within `scope` (policy.requestScope — applied in SQL before ORDER BY / LIMIT). There is no unscoped list. */
  list(limit: number, scope: { sql: string; params: string[] }): ProcurementSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.title, r.buyer_type, r.buyer_company, r.buyer_person_name, r.supplier_name, r.budget_currency, r.budget_max_minor,
                r.status, r.source, r.revision, r.updated_at,
                (SELECT count(*) FROM procurement_request_items i WHERE i.request_id = r.id) AS item_count
           FROM procurement_requests r
          WHERE ${scope.sql}
          ORDER BY r.updated_at DESC, r.id DESC
          LIMIT ?`,
      )
      .all(...scope.params, limit) as Row[];
    return rows.map((row) => {
      const budgetMaxMinor = row.budget_max_minor === null ? null : Number(row.budget_max_minor);
      return {
        id: String(row.id),
        title: String(row.title),
        buyerType: nullableText(row.buyer_type) as BuyerType | null,
        buyerCompany: nullableText(row.buyer_company),
        buyerPersonName: nullableText(row.buyer_person_name),
        supplierName: nullableText(row.supplier_name),
        budgetCurrency: nullableText(row.budget_currency) as BudgetCurrency | null,
        budgetMax: budgetMaxMinor === null ? null : formatBudgetMinor(budgetMaxMinor),
        itemCount: Number(row.item_count),
        status: "DRAFT",
        source: nullableText(row.source) as ProcurementSource | null,
        revision: Number(row.revision),
        updatedAt: String(row.updated_at),
      };
    });
  }
}
