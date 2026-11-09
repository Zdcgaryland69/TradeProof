// Read-only sections of one procurement request — the current record (detail page) or a stored revision
// snapshot (history page), so both show the same fields and the same Item references. Text only: nothing
// the user typed is interpreted as HTML. Strings: src/i18n/en.ts.

import { shortItemRef, type ProcurementRecord } from "@/lib/procurement";
import { en } from "@/i18n/en";
import { ItemRef } from "./CopyId";

const t = en.detail;

function Value({ value, empty = en.common.notSet }: { value: string | number | null; empty?: string }) {
  return value === null || value === "" ? <span className="muted">{empty}</span> : <span className="pre">{value}</span>;
}

export function BuyerFacts({ record }: { record: Pick<ProcurementRecord, "buyerType" | "buyerCompany" | "buyerPersonName"> }) {
  return (
    <>
      <dt>{en.buyer.sectionLabel}</dt>
      <dd>
        {record.buyerType === null ? (
          <span className="pill source-unknown" title={en.buyer.notRecordedHint} data-testid="buyer-type">
            {en.buyer.notRecorded}
          </span>
        ) : (
          <span className="pill" data-testid="buyer-type">
            {en.buyer.types[record.buyerType]}
          </span>
        )}
      </dd>
      {record.buyerType === "INDIVIDUAL" ? (
        <>
          <dt>{en.buyer.personLabelFor("INDIVIDUAL")}</dt>
          <dd>
            <Value value={record.buyerPersonName} />
          </dd>
          <dt>{en.buyer.companyLabelFor("INDIVIDUAL")}</dt>
          <dd>
            <Value value={record.buyerCompany} />
          </dd>
        </>
      ) : (
        <>
          <dt>{en.buyer.companyLabelFor(record.buyerType)}</dt>
          <dd>
            <Value value={record.buyerCompany} />
          </dd>
          <dt>{en.buyer.personLabelFor(record.buyerType)}</dt>
          <dd>
            <Value value={record.buyerPersonName} />
          </dd>
        </>
      )}
    </>
  );
}

export default function RecordView({ record }: { record: ProcurementRecord }) {
  return (
    <>
      <section className="card">
        <h2>{t.basicInfo}</h2>
        <dl className="facts">
          <dt>{en.history.title}</dt>
          <dd className="pre">{record.title}</dd>
          <BuyerFacts record={record} />
          <dt>{t.supplier}</dt>
          <dd>
            <Value value={record.supplierName} empty={t.supplierTbd} />
          </dd>
          <dt>{t.shipFrom}</dt>
          <dd>
            <Value value={record.shipFrom} />
          </dd>
          <dt>{t.shipTo}</dt>
          <dd>
            <Value value={record.shipTo} />
          </dd>
        </dl>
        {record.buyerType === null ? <p className="hint">{en.buyer.notRecordedHint}</p> : <p className="hint">{en.buyer.notPaymentHint}</p>}
      </section>

      <section className="card">
        <h2>{t.itemsHeading(record.items.length)}</h2>
        <ol className="items">
          {record.items.map((item) => (
            <li key={item.id} className="item" data-item-id={item.id}>
              <div className="item-head">
                <strong className="pre">{item.name}</strong> <ItemRef id={item.id} refText={shortItemRef(item.id)} />
              </div>
              <dl className="facts">
                <dt>{t.quantity}</dt>
                <dd>
                  {item.quantity === null ? <span className="muted">{t.notSpecified}</span> : item.quantity} <Value value={item.unit} empty="" />
                </dd>
                <dt>{t.material}</dt>
                <dd>
                  <Value value={item.material} />
                </dd>
                <dt>{t.specification}</dt>
                <dd>
                  <Value value={item.specification} />
                </dd>
                <dt>{t.customization}</dt>
                <dd>
                  <Value value={item.customization} />
                </dd>
                <dt>{t.notes}</dt>
                <dd>
                  <Value value={item.notes} />
                </dd>
              </dl>
            </li>
          ))}
        </ol>
        <p className="hint">{en.ids.itemRefHint}</p>
      </section>

      <section className="card">
        <h2>{t.termsHeading}</h2>
        <dl className="facts">
          <dt>{t.budgetCap}</dt>
          <dd>{record.budgetMax === null ? <span className="muted">{t.noCap(record.budgetCurrency)}</span> : `${record.budgetCurrency} ${record.budgetMax}`}</dd>
          <dt>{t.requiredShipDate}</dt>
          <dd>
            <Value value={record.requiredShipDate} />
          </dd>
          <dt>{t.expectedDeliveryDate}</dt>
          <dd>
            <Value value={record.expectedDeliveryDate} />
          </dd>
          <dt>{t.paymentTerms}</dt>
          <dd>
            <Value value={record.paymentTerms} />
          </dd>
          <dt>{t.additionalRequirements}</dt>
          <dd>
            <Value value={record.additionalRequirements} />
          </dd>
        </dl>
        <p className="hint">{t.budgetHint}</p>
      </section>
    </>
  );
}
