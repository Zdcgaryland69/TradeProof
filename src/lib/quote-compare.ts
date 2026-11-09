// Deterministic comparison of one procurement request against one or more extracted quote
// documents (e.g. a Chinese quotation and the supplier's English summary of it).
// No AI and no exchange rates: amounts in different currencies are flagged, never converted.
// Each finding carries the request text and, per document, the value and its source text.

import {
  formatLeadTime,
  formatLogo,
  formatMoney,
  formatPaymentTerms,
  type ComparableRequest,
  type ExtractedQuote,
  type LeadTime,
  type LogoSpec,
  type Money,
  type PaymentTerms,
  type QuoteItem,
  type Sourced,
} from "./quote.ts";

export type FindingField = "items" | "material" | "logo" | "quantity" | "currency_and_amount" | "incoterm" | "lead_time" | "payment_terms";

export type FindingType =
  | "item_count_mismatch"
  | "spec_mismatch"
  | "spec_mismatch_with_extra_cost"
  | "spec_not_stated"
  | "cannot_compare"
  | "quantity_mismatch"
  | "quantity_mismatch_between_languages"
  | "currency_mismatch_needs_confirmation"
  | "total_arithmetic_mismatch"
  | "over_budget"
  | "incoterm_mismatch"
  | "lead_time_inconsistent"
  | "lead_time_too_late"
  | "payment_terms_mismatch"
  | "payment_terms_mismatch_between_languages";

export type Severity = "high" | "medium" | "low";

export interface FindingEvidence {
  documentId: string;
  language: string;
  /** Display text of the extracted value ("not stated" when missing). */
  value: string;
  /** Verbatim text from the document, or null when the field was not found. */
  source: string | null;
}

export interface Finding {
  field: FindingField;
  /** Request item position, for item-level fields. */
  itemPosition: number | null;
  type: FindingType;
  severity: Severity;
  /** One sentence, English. */
  summary: string;
  request: string | null;
  quotes: FindingEvidence[];
}

export interface CompareOptions {
  /** YYYY-MM-DD, the earliest day a deposit could be paid. Enables the "too late to ship" check. */
  asOf?: string;
}

const NOT_STATED = "not stated";

function evidence<T>(quote: ExtractedQuote, s: Sourced<T> | undefined, show: (v: T) => string): FindingEvidence {
  return {
    documentId: quote.documentId,
    language: quote.language,
    value: s && s.value !== null ? show(s.value) : NOT_STATED,
    source: s?.source ?? null,
  };
}

function distinct<T>(values: T[], key: (v: T) => string = (v) => JSON.stringify(v)): T[] {
  const seen = new Map<string, T>();
  for (const v of values) if (!seen.has(key(v))) seen.set(key(v), v);
  return [...seen.values()];
}

function between(quotes: ExtractedQuote[]): string {
  return distinct(quotes.map((q) => q.language)).length > 1 ? "the quote documents (different languages)" : "the quote documents";
}

function addDays(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Integer-only money multiply. Returns null if the result is not a safe integer. */
function times(m: Money, qty: number): Money | null {
  const minor = m.minor * qty;
  return Number.isSafeInteger(minor) ? { currency: m.currency, minor } : null;
}

export function compareQuote(request: ComparableRequest, quotes: ExtractedQuote[], options: CompareOptions = {}): Finding[] {
  if (quotes.length === 0) return [];
  const findings: Finding[] = [];

  // ---- item lines (matched by position) ----
  const counts = distinct(quotes.map((q) => q.items.length));
  if (counts.length > 1 || counts[0] !== request.items.length) {
    findings.push({
      field: "items",
      itemPosition: null,
      type: "item_count_mismatch",
      severity: "high",
      summary: `The request has ${request.items.length} item line(s); the quote documents have ${quotes.map((q) => q.items.length).join(" / ")}. Lines are compared by position, so check they correspond.`,
      request: String(request.items.length),
      quotes: quotes.map((q) => ({ documentId: q.documentId, language: q.language, value: String(q.items.length), source: null })),
    });
  }

  request.items.forEach((reqItem, index) => {
    const lines = quotes.map((q) => ({ q, item: q.items[index] as QuoteItem | undefined }));
    const pos = reqItem.position;

    // material grade
    if (reqItem.materialText) {
      const grades = lines.map(({ item }) => item?.materialGrade.value ?? null);
      const ev = lines.map(({ q, item }) => evidence(q, item?.materialGrade, (g) => `grade ${g}`));
      if (reqItem.materialGrade === null) {
        if (grades.some((g) => g !== null)) {
          findings.push({
            field: "material", itemPosition: pos, type: "cannot_compare", severity: "low",
            summary: "The request's material wording has no recognised grade, so the quoted grade could not be checked automatically.",
            request: reqItem.materialText, quotes: ev,
          });
        }
      } else if (grades.some((g) => g !== null && g !== reqItem.materialGrade)) {
        findings.push({
          field: "material", itemPosition: pos, type: "spec_mismatch", severity: "high",
          summary: `Requested grade ${reqItem.materialGrade}; quoted ${grades.map((g) => g ?? NOT_STATED).join(" / ")}.`,
          request: reqItem.materialText, quotes: ev,
        });
      } else if (grades.some((g) => g === null)) {
        findings.push({
          field: "material", itemPosition: pos, type: "spec_not_stated", severity: "medium",
          summary: `Requested grade ${reqItem.materialGrade}; at least one quote document does not state the grade.`,
          request: reqItem.materialText, quotes: ev,
        });
      }
    }

    // logo
    if (reqItem.logoText) {
      const logos = lines.map(({ item }) => item?.logo.value ?? null);
      const ev = lines.map(({ q, item }) => evidence(q, item?.logo, formatLogo));
      const want = reqItem.logo;
      const differs = (l: LogoSpec | null) =>
        want !== null && l !== null &&
        ((want.method !== null && l.method !== null && l.method !== want.method) ||
          (want.colours !== null && l.colours !== null && l.colours !== want.colours));
      if (want === null) {
        if (logos.some((l) => l !== null)) {
          findings.push({
            field: "logo", itemPosition: pos, type: "cannot_compare", severity: "low",
            summary: "The request's logo wording was not recognised, so the quoted logo could not be checked automatically.",
            request: reqItem.logoText, quotes: ev,
          });
        }
      } else if (logos.some(differs)) {
        const surcharges = quotes.flatMap((q) =>
          q.extraCharges
            .filter((c) => c.value !== null && want.method !== null && c.value.logoMethod === want.method)
            .map((c) => ({ q, c })),
        );
        const withCost = surcharges.length > 0;
        findings.push({
          field: "logo", itemPosition: pos,
          type: withCost ? "spec_mismatch_with_extra_cost" : "spec_mismatch", severity: "medium",
          summary:
            `Requested ${formatLogo(want)}; quoted ${logos.map((l) => (l ? formatLogo(l) : NOT_STATED)).join(" / ")}.` +
            (withCost
              ? ` The requested method is offered only as an extra charge (${surcharges
                  .map(({ c }) => (c.value!.perUnit ? `${formatMoney(c.value!.perUnit)} per unit` : c.value!.description))
                  .join("; ")}), not included in the quoted price.`
              : ""),
          request: reqItem.logoText,
          quotes: [
            ...ev,
            ...surcharges.map(({ q, c }) => evidence(q, c, (v) => `extra charge: ${v.perUnit ? formatMoney(v.perUnit) + " per unit" : v.description}`)),
          ],
        });
      } else if (logos.some((l) => l === null)) {
        findings.push({
          field: "logo", itemPosition: pos, type: "spec_not_stated", severity: "medium",
          summary: `Requested ${formatLogo(want)}; at least one quote document does not state the logo method.`,
          request: reqItem.logoText, quotes: ev,
        });
      }
    }

    // quantity
    const qtys = lines.map(({ item }) => item?.quantity.value ?? null);
    const stated = qtys.filter((v): v is number => v !== null);
    const qEv = lines.map(({ q, item }) => evidence(q, item?.quantity, (n) => `${n}${item?.unit.value ? " " + item.unit.value : ""}`));
    const reqQty = reqItem.quantity === null ? null : `${reqItem.quantity}${reqItem.unit ? " " + reqItem.unit : ""}`;
    if (distinct(stated).length > 1) {
      findings.push({
        field: "quantity", itemPosition: pos, type: "quantity_mismatch_between_languages", severity: "high",
        summary: `Quantity differs between ${between(quotes)}: ${qtys.map((v) => v ?? NOT_STATED).join(" / ")}` +
          (reqItem.quantity !== null ? `; requested ${reqItem.quantity}.` : "."),
        request: reqQty, quotes: qEv,
      });
    } else if (reqItem.quantity !== null && stated.length > 0 && stated[0] !== reqItem.quantity) {
      findings.push({
        field: "quantity", itemPosition: pos, type: "quantity_mismatch", severity: "high",
        summary: `Requested ${reqItem.quantity}; quoted ${stated[0]}.`,
        request: reqQty, quotes: qEv,
      });
    }
  });

  // ---- currency and amount ----
  const priced = quotes.map((q) => ({
    q,
    unit: q.items[0]?.unitPrice.value ?? null,
    total: q.total.value,
    lineTotals: q.items.map((it) => (it.unitPrice.value && it.quantity.value !== null ? times(it.unitPrice.value, it.quantity.value) : null)),
  }));
  const currencies = distinct(
    priced.flatMap((p) => [...p.q.items.map((it) => it.unitPrice.value?.currency ?? null), p.total?.currency ?? null]).filter((c): c is Money["currency"] => c !== null),
  );
  const budgetText = request.budget ? `${formatMoney(request.budget)} total budget` : null;
  const amountEv = (p: (typeof priced)[number]): FindingEvidence[] => [
    evidence(p.q, p.q.items[0]?.unitPrice, (m) => `${formatMoney(m)} per unit`),
    ...(p.q.total.value !== null || p.q.total.source !== null ? [evidence(p.q, p.q.total, (m) => `${formatMoney(m)} total`)] : []),
  ];
  if (currencies.length > 1 || (request.budget && currencies.some((c) => c !== request.budget!.currency))) {
    findings.push({
      field: "currency_and_amount", itemPosition: null, type: "currency_mismatch_needs_confirmation", severity: "high",
      summary: `Quoted in ${currencies.join(" and ")}` + (request.budget ? `; budget is in ${request.budget.currency}` : "") +
        ". Amounts in different currencies are not converted — confirm with the supplier which currency and amount is binding.",
      request: budgetText, quotes: priced.flatMap(amountEv),
    });
  }
  for (const p of priced) {
    const lines = p.lineTotals;
    if (p.total && lines.length > 0 && lines.every((l) => l !== null && l.currency === p.total!.currency)) {
      const sum = lines.reduce((acc, l) => acc + l!.minor, 0);
      if (sum !== p.total.minor) {
        findings.push({
          field: "currency_and_amount", itemPosition: null, type: "total_arithmetic_mismatch", severity: "high",
          summary: `In ${p.q.documentId}, unit price × quantity = ${formatMoney({ currency: p.total.currency, minor: sum })}, but the stated total is ${formatMoney(p.total)}.`,
          request: null, quotes: amountEv(p),
        });
      }
    }
    if (request.budget) {
      const total = p.total ?? (lines.length > 0 && lines.every((l) => l !== null) && distinct(lines.map((l) => l!.currency)).length === 1
        ? { currency: lines[0]!.currency, minor: lines.reduce((a, l) => a + l!.minor, 0) }
        : null);
      if (total && total.currency === request.budget.currency && total.minor > request.budget.minor) {
        findings.push({
          field: "currency_and_amount", itemPosition: null, type: "over_budget", severity: "high",
          summary: `${p.q.documentId}: total ${formatMoney(total)} exceeds the budget of ${formatMoney(request.budget)}.`,
          request: budgetText, quotes: amountEv(p),
        });
      }
    }
  }

  // ---- incoterm ----
  if (request.incotermRule) {
    const rules = quotes.map((q) => q.incoterm.value?.rule ?? null);
    if (rules.some((r) => r !== null && r !== request.incotermRule)) {
      findings.push({
        field: "incoterm", itemPosition: null, type: "incoterm_mismatch", severity: "high",
        summary: `Requested ${request.incotermRule}; quoted ${rules.map((r) => r ?? NOT_STATED).join(" / ")}.`,
        request: request.incotermText,
        quotes: quotes.map((q) => evidence(q, q.incoterm, (v) => `${v.rule}${v.place ? " " + v.place : ""}`)),
      });
    }
  }

  // ---- lead time ----
  const times_ = quotes.map((q) => q.leadTime.value);
  const ltEv = quotes.map((q) => evidence(q, q.leadTime, formatLeadTime));
  const statedLt = times_.filter((t): t is LeadTime => t !== null);
  const longest = statedLt.length > 0 ? Math.max(...statedLt.map((t) => t.days)) : null;
  const shipBy = request.requiredShipDate;
  const shipByText = shipBy ? `ship by ${shipBy}` : null;
  const depositDeadline = shipBy && longest !== null ? ` To ship by ${shipBy} at the longest stated lead time, the deposit must be paid by ${addDays(shipBy, -longest)}.` : "";
  if (distinct(statedLt).length > 1) {
    findings.push({
      field: "lead_time", itemPosition: null, type: "lead_time_inconsistent", severity: "medium",
      summary: `Lead time differs between ${between(quotes)}: ${times_.map((t) => (t ? formatLeadTime(t) : NOT_STATED)).join(" / ")}.${depositDeadline}`,
      request: shipByText, quotes: ltEv,
    });
  }
  if (shipBy && options.asOf && longest !== null && addDays(options.asOf, longest) > shipBy) {
    findings.push({
      field: "lead_time", itemPosition: null, type: "lead_time_too_late", severity: "high",
      summary: `Even with the deposit paid on ${options.asOf}, ${longest} days of lead time ends on ${addDays(options.asOf, longest)}, after the required ship date ${shipBy}.`,
      request: shipByText, quotes: ltEv,
    });
  }

  // ---- payment terms ----
  const terms = quotes.map((q) => q.paymentTerms.value);
  const ptEv = quotes.map((q) => evidence(q, q.paymentTerms, formatPaymentTerms));
  const statedPt = terms.filter((t): t is PaymentTerms => t !== null);
  if (distinct(statedPt).length > 1) {
    findings.push({
      field: "payment_terms", itemPosition: null, type: "payment_terms_mismatch_between_languages", severity: "high",
      summary: `Payment terms differ between ${between(quotes)}: ${terms.map((t) => (t ? formatPaymentTerms(t) : NOT_STATED)).join(" / ")}` +
        (request.paymentTerms ? `; accepted terms are ${formatPaymentTerms(request.paymentTerms)}.` : "."),
      request: request.paymentTermsText, quotes: ptEv,
    });
  } else if (request.paymentTerms && statedPt.length > 0) {
    const t = statedPt[0];
    const want = request.paymentTerms;
    if (t.depositPercent !== want.depositPercent || (want.balanceTiming !== null && t.balanceTiming !== null && t.balanceTiming !== want.balanceTiming)) {
      findings.push({
        field: "payment_terms", itemPosition: null, type: "payment_terms_mismatch", severity: "high",
        summary: `Accepted terms are ${formatPaymentTerms(want)}; quoted ${formatPaymentTerms(t)}.`,
        request: request.paymentTermsText, quotes: ptEv,
      });
    }
  } else if (request.paymentTermsText && !request.paymentTerms && statedPt.length > 0) {
    findings.push({
      field: "payment_terms", itemPosition: null, type: "cannot_compare", severity: "low",
      summary: "The request's payment terms wording was not recognised, so the quoted terms could not be checked automatically.",
      request: request.paymentTermsText, quotes: ptEv,
    });
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
