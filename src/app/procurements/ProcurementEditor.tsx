"use client";

// Procurement request form (create + edit). The server validates everything; this component only
// keeps the user's text, shows the server's field errors next to the fields, and never discards
// input on a failed save. All user text is rendered as text by React (no HTML is interpreted).
// Strings: src/i18n/en.ts.

import { csrfHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUDGET_CURRENCIES,
  BUYER_TYPES,
  MAX_ITEMS,
  TEXT_LIMITS,
  emptyItem,
  recordToInput,
  shortItemRef,
  shortProcurementId,
  type BuyerType,
  type FieldError,
  type ProcurementInput,
  type ProcurementItemInput,
  type ProcurementRecord,
} from "@/lib/procurement";
import { en } from "@/i18n/en";
import { ItemRef } from "./CopyId";

const t = en.editor;

type Props =
  | { mode: "create"; initial: ProcurementInput; demo: ProcurementInput | null }
  /** onSaved(record, changed): changed = false when the server found nothing to save (no new revision). */
  | { mode: "edit"; record: ProcurementRecord; onSaved: (record: ProcurementRecord, changed: boolean) => void; onCancel: () => void };

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "conflict"; current: ProcurementRecord };

interface ApiReply {
  ok?: boolean;
  code?: string;
  message?: string;
  errors?: FieldError[];
  record?: ProcurementRecord;
  current?: ProcurementRecord;
}

/** A row whose text fields are all empty. Its id (if any) does not count: clearing a saved row removes it. */
function isBlankItem(item: ProcurementItemInput): boolean {
  return Object.entries(item).every(([key, v]) => key === "id" || (v as string).trim() === "");
}

/** Fully empty item rows are left out of the request; error paths are mapped back to the row on screen. */
function buildBody(form: ProcurementInput): { body: ProcurementInput; rowOf: number[] } {
  const rowOf: number[] = [];
  const items = form.items.filter((item, index) => {
    if (isBlankItem(item)) return false;
    rowOf.push(index);
    return true;
  });
  return { body: { ...form, items }, rowOf };
}

function mapErrors(errors: FieldError[], rowOf: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors) {
    const field = e.field.replace(/^items\[(\d+)\]/, (_, i: string) => `items[${rowOf[Number(i)] ?? i}]`);
    out[field] ??= e.message;
  }
  return out;
}

function describeField(field: string): string {
  const item = /^items\[(\d+)\](?:\.(\w+))?$/.exec(field);
  if (item) return `${t.item(Number(item[1]) + 1)}${item[2] ? ` · ${item[2]}` : ""}`;
  return t.fieldLabels[field] ?? field;
}

async function send(method: "POST" | "PUT", url: string, body: unknown): Promise<{ status: number; data: ApiReply | null }> {
  try {
    const response = await fetch(url, {
      method,
      headers: { ...csrfHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as ApiReply | null;
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

/** Names of the fields where the user's edits differ from the newer saved version. */
function changedFields(mine: ProcurementInput, theirs: ProcurementInput): string[] {
  const out: string[] = [];
  for (const key of Object.keys(t.fieldLabels) as (keyof ProcurementInput)[]) {
    if (key === "items") {
      if (JSON.stringify(mine.items.filter((i) => !isBlankItem(i))) !== JSON.stringify(theirs.items)) out.push(t.fieldLabels.items);
    } else if (key in mine && String(mine[key]).trim() !== String(theirs[key]).trim()) {
      out.push(t.fieldLabels[key]);
    }
  }
  return out;
}

export default function ProcurementEditor(props: Props) {
  const router = useRouter();
  const startInput = props.mode === "create" ? props.initial : recordToInput(props.record);
  const [baseRecord, setBaseRecord] = useState<ProcurementRecord | null>(props.mode === "edit" ? props.record : null);
  const [baseline, setBaseline] = useState<ProcurementInput>(startInput);
  const [form, setForm] = useState<ProcurementInput>(startInput);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [demoLoaded, setDemoLoaded] = useState(false);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline]);
  const saving = status.kind === "saving";
  const outcomeRef = useRef<HTMLDivElement>(null);
  // An old request whose buyer type was never recorded may keep it that way; a recorded type cannot be cleared.
  const typeNotRecorded = props.mode === "edit" && baseRecord?.buyerType === null;
  const buyerType = (BUYER_TYPES as readonly string[]).includes(form.buyerType) ? (form.buyerType as BuyerType) : null;

  // A refused save is reported in a panel at the end of a long form. Bring it into view (and focus it)
  // so the user sees it wherever they clicked Save; the sticky bar also states the outcome.
  useEffect(() => {
    if (status.kind === "conflict" || status.kind === "invalid" || status.kind === "failed") {
      outcomeRef.current?.scrollIntoView({ block: "center" });
      outcomeRef.current?.focus({ preventScroll: true });
    }
  }, [status]);

  // Warn before leaving with unsaved edits: reload/close (beforeunload) and in-app links (click capture).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm(t.leaveConfirm)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  function set<K extends Exclude<keyof ProcurementInput, "items">>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /** Reorders rows; each row keeps its id, so the server keeps the line's identity. */
  function moveItem(index: number, delta: -1 | 1) {
    setForm((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.items.length) return prev;
      const items = [...prev.items];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...prev, items };
    });
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("items"))));
  }

  function setItem(index: number, key: Exclude<keyof ProcurementItemInput, "id">, value: string) {
    setForm((prev) => ({ ...prev, items: prev.items.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }));
  }

  function addItem() {
    setForm((prev) => (prev.items.length >= MAX_ITEMS ? prev : { ...prev, items: [...prev.items, emptyItem()] }));
  }

  function removeItem(index: number) {
    setForm((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
    // Row numbers shift, so old per-row messages no longer apply.
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("items"))));
  }

  function loadDemo() {
    if (props.mode !== "create" || !props.demo) return;
    if (dirty && !window.confirm(t.replaceWithDemo)) return;
    setForm(props.demo);
    setErrors({});
    setStatus({ kind: "idle" });
    setDemoLoaded(true);
  }

  async function save(overrideRevision?: number) {
    const { body, rowOf } = buildBody(form);
    setStatus({ kind: "saving" });
    const result =
      props.mode === "create"
        ? // Source is recorded once: a form started from Load demo stays DEMO_SAMPLE even if the user edits it.
          await send("POST", "/api/procurements", { ...body, source: demoLoaded ? "DEMO_SAMPLE" : "USER_INPUT" })
        : await send("PUT", `/api/procurements/${baseRecord!.id}`, { ...body, revision: overrideRevision ?? baseRecord!.revision });

    const data = result.data;
    if ((result.status === 201 || result.status === 200) && data?.record) {
      setErrors({});
      if (props.mode === "create") {
        setBaseline(form); // nothing unsaved any more: navigating away must not warn
        setStatus({ kind: "idle" });
        router.push(`/procurements/${data.record.id}?saved=created`);
      } else {
        setBaseRecord(data.record);
        setBaseline(recordToInput(data.record));
        setForm(recordToInput(data.record));
        setStatus({ kind: "idle" });
        props.onSaved(data.record, data.code !== "NO_CHANGES");
      }
      return;
    }
    if (result.status === 422 && data?.code === "CLIENT_OUTDATED") {
      setStatus({ kind: "failed", message: data.message ?? t.outdated });
      return;
    }
    if (result.status === 422 && data?.errors) {
      setErrors(mapErrors(data.errors, rowOf));
      setStatus({ kind: "invalid", message: data.message ?? t.someFields });
      return;
    }
    if (result.status === 409 && data?.current) {
      setStatus({ kind: "conflict", current: data.current });
      return;
    }
    // 8 Nov: no answer (status 0) or a 5xx — the save may be stored; never "Save failed … try again". A later save from
    // this form is checked against the revision on the server (409 if it was stored meanwhile).
    if (result.status === 0 || result.status >= 500) {
      setStatus({ kind: "failed", message: t.outcomeUnknownKeepText });
      return;
    }
    setStatus({ kind: "failed", message: t.saveFailed(data?.message ?? `HTTP ${result.status}`) });
  }

  function loadLatest(current: ProcurementRecord) {
    if (!window.confirm(t.loadLatestConfirm)) return;
    setBaseRecord(current);
    setBaseline(recordToInput(current));
    setForm(recordToInput(current));
    setErrors({});
    setStatus({ kind: "idle" });
  }

  function overwrite(current: ProcurementRecord) {
    if (!window.confirm(t.overwriteConfirm(current.revision))) return;
    setBaseRecord(current);
    void save(current.revision);
  }

  function cancel() {
    if (props.mode !== "edit") return;
    if (dirty && !window.confirm(t.discardConfirm)) return;
    props.onCancel();
  }

  const err = (field: string) => errors[field];
  const errorList = Object.entries(errors);

  const text = (field: Exclude<keyof ProcurementInput, "items" | "buyerType">, label: string, opts: { max: number; hint?: string; required?: boolean; multiline?: boolean; placeholder?: string }) => {
    const id = `f-${field}`;
    const message = err(field);
    const common = {
      id,
      value: form[field],
      maxLength: opts.max,
      placeholder: opts.placeholder,
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `${id}-error` : opts.hint ? `${id}-hint` : undefined,
    };
    return (
      <div className={`field${opts.multiline ? " full" : ""}`}>
        <label htmlFor={id}>
          {label}
          {opts.required ? <span className="req"> *</span> : null}
        </label>
        {opts.multiline ? (
          <textarea {...common} rows={4} onChange={(e) => set(field, e.target.value)} />
        ) : (
          <input {...common} type="text" onChange={(e) => set(field, e.target.value)} />
        )}
        {opts.hint ? (
          <span id={`${id}-hint`} className="hint">
            {opts.hint}
          </span>
        ) : null}
        {message ? (
          <span id={`${id}-error`} className="error" role="alert">
            {message}
          </span>
        ) : null}
      </div>
    );
  };

  const itemText = (index: number, key: Exclude<keyof ProcurementItemInput, "id">, label: string, max: number, opts: { multiline?: boolean; required?: boolean; inputMode?: "numeric"; placeholder?: string } = {}) => {
    const field = `items[${index}].${key}`;
    const id = `f-item-${index}-${key}`;
    const message = err(field);
    const common = {
      id,
      value: form.items[index][key],
      maxLength: max,
      placeholder: opts.placeholder,
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `${id}-error` : undefined,
    };
    return (
      <div className={`field${opts.multiline ? " full" : ""}`}>
        <label htmlFor={id}>
          {label}
          {opts.required ? <span className="req"> *</span> : null}
        </label>
        {opts.multiline ? (
          <textarea {...common} rows={2} onChange={(e) => setItem(index, key, e.target.value)} />
        ) : (
          <input {...common} type="text" inputMode={opts.inputMode} onChange={(e) => setItem(index, key, e.target.value)} />
        )}
        {message ? (
          <span id={`${id}-error`} className="error" role="alert">
            {message}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <form
      className="editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!saving) void save();
      }}
    >
      {props.mode === "create" ? (
        <div className="card demo-box">
          <div>
            <strong>{t.demoData}</strong> <span className="muted small">{t.demoHint}</span>
          </div>
          <button type="button" onClick={loadDemo} disabled={!props.demo || saving}>
            {t.loadDemo}
          </button>
          {!props.demo ? <p className="error">{t.demoMissing}</p> : null}
        </div>
      ) : null}

      {demoLoaded ? (
        <p className="sandbox-banner" role="note">
          {t.demoLoaded}
        </p>
      ) : null}

      {props.mode === "edit" && baseRecord ? (
        <p className="small muted">
          {t.editing(shortProcurementId(baseRecord.id), baseRecord.revision)} · <span className="pill">{baseRecord.status}</span>
        </p>
      ) : null}

      <fieldset className="card">
        <legend>{t.basicInfo}</legend>
        <div className="grid">
          {text("title", t.title, { max: TEXT_LIMITS.title, required: true, placeholder: t.titlePlaceholder })}
          <fieldset className="field full buyer-type" aria-describedby="f-buyerType-hint" aria-invalid={err("buyerType") ? true : undefined}>
            <legend>
              {en.buyer.sectionLabel}
              {typeNotRecorded ? null : <span className="req"> *</span>}
            </legend>
            {BUYER_TYPES.map((type) => (
              <label key={type} className="radio-inline">
                <input type="radio" name="buyerType" value={type} checked={form.buyerType === type} onChange={() => set("buyerType", type)} />{" "}
                {en.buyer.types[type]}
              </label>
            ))}
            {typeNotRecorded ? (
              <label className="radio-inline">
                <input type="radio" name="buyerType" value="" checked={form.buyerType === ""} onChange={() => set("buyerType", "")} /> {en.buyer.keepNotRecorded}
              </label>
            ) : null}
            <span id="f-buyerType-hint" className="hint">
              {typeNotRecorded && form.buyerType === "" ? en.buyer.notRecordedHint : en.buyer.notPaymentHint}
            </span>
            {err("buyerType") ? (
              <span className="error" role="alert">
                {err("buyerType")}
              </span>
            ) : null}
          </fieldset>
          {buyerType === "INDIVIDUAL" ? (
            <>
              {text("buyerPersonName", en.buyer.yourName, { max: TEXT_LIMITS.buyerPersonName, required: true })}
              {text("buyerCompany", en.buyer.companyOrganization, { max: TEXT_LIMITS.buyerCompany })}
            </>
          ) : (
            <>
              {text("buyerCompany", en.buyer.companyName, { max: TEXT_LIMITS.buyerCompany, required: buyerType === "BUSINESS" })}
              {text("buyerPersonName", en.buyer.contactName, { max: TEXT_LIMITS.buyerPersonName })}
            </>
          )}
          {text("supplierName", t.supplier, { max: TEXT_LIMITS.supplierName, hint: t.supplierHint })}
          {text("shipFrom", t.shipFrom, { max: TEXT_LIMITS.shipFrom })}
          {text("shipTo", t.shipTo, { max: TEXT_LIMITS.shipTo })}
        </div>
      </fieldset>

      <fieldset className="card">
        <legend>{t.items}</legend>
        {err("items") ? (
          <p className="error" role="alert">
            {err("items")}
          </p>
        ) : null}
        {form.items.length === 0 ? <p className="muted">{t.noItems}</p> : null}
        <ol className="items">
          {form.items.map((item, index) => (
            <li key={item.id ?? `new-${index}`} className="item" data-item-id={item.id ?? "new"}>
              <div className="item-head">
                <strong>{t.item(index + 1)}</strong>{" "}
                {item.id ? <ItemRef id={item.id} refText={shortItemRef(item.id)} /> : <span className="muted small">{en.ids.newLine}</span>}
                <span className="item-tools">
                  <button type="button" className="link-button" onClick={() => moveItem(index, -1)} disabled={saving || index === 0} aria-label={t.moveUpLabel(index + 1)}>
                    {t.moveUp}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => moveItem(index, 1)}
                    disabled={saving || index === form.items.length - 1}
                    aria-label={t.moveDownLabel(index + 1)}
                  >
                    {t.moveDown}
                  </button>
                  <button type="button" className="link-button" onClick={() => removeItem(index)} disabled={saving}>
                    {t.remove}
                  </button>
                </span>
              </div>
              {err(`items[${index}]`) ? <p className="error">{err(`items[${index}]`)}</p> : null}
              <div className="grid">
                {itemText(index, "name", t.itemName, TEXT_LIMITS.itemName, { required: true })}
                {itemText(index, "quantity", t.quantity, 12, { inputMode: "numeric", placeholder: t.quantityPlaceholder })}
                {itemText(index, "unit", t.unit, TEXT_LIMITS.itemUnit, { placeholder: t.unitPlaceholder })}
                {itemText(index, "material", t.material, TEXT_LIMITS.itemMaterial, { multiline: true })}
                {itemText(index, "specification", t.specification, TEXT_LIMITS.itemSpecification, { multiline: true })}
                {itemText(index, "customization", t.customization, TEXT_LIMITS.itemCustomization, { multiline: true })}
                {itemText(index, "notes", t.notes, TEXT_LIMITS.itemNotes, { multiline: true })}
              </div>
            </li>
          ))}
        </ol>
        <button type="button" onClick={addItem} disabled={saving || form.items.length >= MAX_ITEMS}>
          {t.addItem}
        </button>
        <span className="hint">{t.itemsHint(MAX_ITEMS)}</span>
      </fieldset>

      <fieldset className="card">
        <legend>{t.terms}</legend>
        <div className="grid">
          <div className="field">
            <label htmlFor="f-budgetCurrency">{t.budgetCurrency}</label>
            <select
              id="f-budgetCurrency"
              value={form.budgetCurrency}
              onChange={(e) => set("budgetCurrency", e.target.value)}
              aria-invalid={err("budgetCurrency") ? true : undefined}
            >
              <option value="">{t.currencyNotSet}</option>
              {BUDGET_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="hint">{t.currencyHint}</span>
            {err("budgetCurrency") ? (
              <span className="error" role="alert">
                {err("budgetCurrency")}
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="f-budgetMax">{t.budgetCap}</label>
            <input
              id="f-budgetMax"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 1800.00"
              value={form.budgetMax}
              maxLength={20}
              onChange={(e) => set("budgetMax", e.target.value)}
              aria-invalid={err("budgetMax") ? true : undefined}
            />
            <span className="hint">{t.budgetHint}</span>
            {err("budgetMax") ? (
              <span className="error" role="alert">
                {err("budgetMax")}
              </span>
            ) : null}
          </div>
          {(["requiredShipDate", "expectedDeliveryDate"] as const).map((field) => (
            <div className="field" key={field}>
              <label htmlFor={`f-${field}`}>{field === "requiredShipDate" ? t.requiredShipDate : t.expectedDeliveryDate}</label>
              <input
                id={`f-${field}`}
                type="date"
                min="2000-01-01"
                max="2100-12-31"
                value={form[field]}
                onChange={(e) => set(field, e.target.value)}
                aria-invalid={err(field) ? true : undefined}
              />
              {err(field) ? (
                <span className="error" role="alert">
                  {err(field)}
                </span>
              ) : null}
            </div>
          ))}
          {text("paymentTerms", t.paymentTerms, { max: TEXT_LIMITS.paymentTerms, multiline: true, placeholder: t.paymentTermsPlaceholder })}
          {text("additionalRequirements", t.additionalRequirements, { max: TEXT_LIMITS.additionalRequirements, multiline: true })}
        </div>
      </fieldset>

      <div ref={outcomeRef} tabIndex={-1} className="outcome">
        {status.kind === "conflict" ? (
          <div className="card alert warn" role="alert">
            <h2>{t.conflictTitle}</h2>
            <p>{t.conflictBody(status.current.revision, status.current.updatedAt)}</p>
            {(() => {
              const fields = changedFields(form, recordToInput(status.current));
              return fields.length > 0 ? <p className="small">{t.differsIn(fields.join(", "))}</p> : <p className="small">{t.matchesSaved}</p>;
            })()}
            <div className="actions">
              <button type="button" onClick={() => loadLatest(status.current)}>
                {t.loadLatest}
              </button>
              <button type="button" onClick={() => overwrite(status.current)}>
                {t.overwrite(status.current.revision)}
              </button>
            </div>
          </div>
        ) : null}

        {status.kind === "invalid" ? (
          <div className="card alert error-box" role="alert">
            <strong>
              {t.notSavedPrefix} {status.message}
            </strong>
            <ul className="small">
              {errorList.map(([field, message]) => (
                <li key={field}>
                  {describeField(field)}: {message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {status.kind === "failed" ? (
          <div className="card alert error-box" role="alert">
            {status.message}
          </div>
        ) : null}
      </div>

      <div className="actions sticky">
        <button type="submit" className="primary" disabled={saving || status.kind === "conflict"}>
          {saving ? t.saving : t.save}
        </button>
        {props.mode === "edit" ? (
          <button type="button" onClick={cancel} disabled={saving}>
            {t.cancel}
          </button>
        ) : null}
        {status.kind === "conflict" ? (
          <strong className="error" role="status">
            {t.conflictBar(status.current.revision)}
          </strong>
        ) : status.kind === "invalid" || status.kind === "failed" ? (
          <strong className="error" role="status">
            {t.notSavedBar}
          </strong>
        ) : null}
        {dirty ? (
          <span className="unsaved" role="status">
            {t.unsaved}
          </span>
        ) : (
          <span className="muted small">{t.noUnsaved}</span>
        )}
      </div>
    </form>
  );
}
