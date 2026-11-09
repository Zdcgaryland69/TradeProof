// Bilingual clarification draft (27 Oct): English and Simplified Chinese questions built from ONE stored
// comparison, with paired templates (no model, no translation service), plus a deterministic check of the
// two languages against each other and against the values the comparison gave. Pure TypeScript, no I/O.
//
// What this is — and is not:
// - A TEMPLATE-GENERATED DRAFT to review before sending. It is never sent from here, never an AI result and
//   never a "verified translation". Copying it changes nothing.
// - Questions come only from Difference / Needs-clarification rows and open fee lines of the comparison.
//   Each keeps a stable id and where it came from (row or fee, field, item line, values, runs, reviews).
// - Values the model read are worded as "as we read your quote" — never as agreed facts. Item names and
//   quoted supplier / request wording are kept as written inside “…” (not translated).
// - The check compares numbers, amounts, currencies, percentages, units, charging basis, dates, trade-term
//   codes and quoted references per question. Passing it does NOT show that meaning, negation, conditions or
//   commercial intent are the same in both languages.

import type { Comparison, ComparisonRow, FeeView, QuoteValue } from "./comparison.ts";
import type { FeeKind } from "./extraction.ts";
import { parsePaymentTerms } from "./quote.ts";
import { currenciesIn, scanNumbers, type Reading } from "../server/extraction/numbers.ts";

export const CLARIFICATION_TEMPLATE_VERSION = "clarify-template-2026-10-27.1";
export const BILINGUAL_CHECK_RULES = "bilingual-check-2026-10-27.1";

export type Lang = "en" | "zh";
export const LANGS: readonly Lang[] = ["en", "zh"];

/** SUPPLIER = proposed for the message (selected by default); SUPPLIER_OPTIONAL = offered, not selected by default. */
export type Audience = "SUPPLIER" | "SUPPLIER_OPTIONAL";

export type TemplateId =
  | "MATERIAL_DIFFERS"
  | "LOGO_DIFFERS"
  | "QUANTITY_DIFFERS"
  | "UNIT_DIFFERS"
  | "ITEM_VALUE_MISSING"
  | "SPEC_CONFIRM"
  | "NOT_QUOTED"
  | "EXTRA_QUOTE_ITEM"
  | "CURRENCY_DIFFERS"
  | "SEVERAL_CURRENCIES"
  | "CURRENCY_MISSING"
  | "OVER_BUDGET"
  | "TOTAL_MISSING"
  | "TOTAL_DIFFERS"
  | "INCOTERM_DIFFERS"
  | "TERM_NOT_AGREED"
  | "TERM_MISSING"
  | "TERM_UNCLEAR"
  | "LEAD_TIME_TOO_LATE"
  | "LEAD_TIME_START_UNCLEAR"
  | "LEAD_TIME_APPROXIMATE"
  | "PAYMENT_DIFFERS"
  | "PAYMENT_PARTIAL"
  | "FEE_OPEN"
  | "FEE_DUPLICATE";

/** One stored value a question relies on (path in the run result, which run, the user's latest review of it). */
export interface ValueSourceRef {
  path: string;
  runId: string;
  source: QuoteValue["source"];
  versionNumber: number;
  review: QuoteValue["review"];
  reviewId: string | null;
  usedFrom: QuoteValue["usedFrom"];
}

/** Where a question (or a buyer-side check) comes from in the comparison. */
export interface QuestionOrigin {
  kind: "ROW" | "FEE";
  /** Comparison row key, or `fee-<source>-<index>`. */
  key: string;
  field: string;
  outcome: "DIFFERENCE" | "OPEN";
  /** Row note (why the comparison flagged it), or the fee status and reasons. */
  note: { code: string; args: Record<string, string> };
  requestItemId: string | null;
  quoteItemIndex: number | null;
  provisionalPairing: boolean;
  values: ValueSourceRef[];
}

export interface DraftQuestion {
  /** Stable for the same run: template + the comparison row / fee it comes from. */
  id: string;
  template: TemplateId;
  audience: Audience;
  outcome: "DIFFERENCE" | "OPEN";
  field: string;
  requestItemId: string | null;
  itemName: string | null;
  /** The supplier would learn the buyer's budget from this question. */
  revealsBudget: boolean;
  en: string;
  zh: string;
  origins: QuestionOrigin[];
}

/** Open points that are for the buyer to settle (pairing, own wording, own corrections) — never put into the message. */
export interface BuyerCheck {
  id: string;
  field: string;
  itemName: string | null;
  origin: QuestionOrigin;
}

export interface GeneratedDraft {
  templateVersion: string;
  questions: DraftQuestion[];
  buyerChecks: BuyerCheck[];
  intro: Record<Lang, string>;
  closing: Record<Lang, string>;
}

// ---------------------------------------------------------------- template helpers

const q = (s: string) => `“${s.replace(/[“”]/g, '"').replace(/\s+/g, " ").trim()}”`;
const has = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** Unit words we can name in both languages; anything else is kept exactly as written in both. */
const UNIT_PAIRS: [RegExp, string, string][] = [
  [/^(?:pcs?|pieces?|units?|ea|个|只|件|支|把)$/i, "pcs", "件"],
  [/^(?:sets?|套)$/i, "sets", "套"],
  [/^(?:box(?:es)?|盒)$/i, "boxes", "盒"],
  [/^(?:cartons?|ctns?|箱)$/i, "cartons", "箱"],
  [/^(?:pairs?|双)$/i, "pairs", "双"],
];

function qtyText(n: number, unit: string | null): Record<Lang, string> {
  if (!has(unit)) return { en: String(n), zh: String(n) };
  const u = unit.normalize("NFKC").trim().replace(/\.$/, "");
  const pair = UNIT_PAIRS.find(([re]) => re.test(u));
  return pair ? { en: `${n} ${pair[1]}`, zh: `${n} ${pair[2]}` } : { en: `${n} ${u}`, zh: `${n} ${u}` };
}

const FIELD: Record<string, Record<Lang, string>> = {
  quantity: { en: "quantity", zh: "数量" },
  unitPrice: { en: "unit price", zh: "单价" },
  material: { en: "material", zh: "材质" },
  logo: { en: "logo / customisation", zh: "Logo／定制要求" },
  incoterm: { en: "trade term (Incoterms rule and named place)", zh: "贸易术语（Incoterms 规则及指定地点）" },
  leadTime: { en: "lead time", zh: "交货期" },
  paymentTerms: { en: "payment terms", zh: "付款条件" },
};

const FEE_KIND: Record<FeeKind, Record<Lang, string>> = {
  GOODS: { en: "Goods", zh: "货款" },
  FREIGHT: { en: "Freight", zh: "运费" },
  INSURANCE: { en: "Insurance", zh: "保险费" },
  TAX_DUTY: { en: "Taxes / duties", zh: "税费／关税" },
  CUSTOMS_SERVICE: { en: "Customs service", zh: "报关服务费" },
  PAYMENT_FEE: { en: "Payment / bank fee", zh: "支付／银行手续费" },
  PACKAGING: { en: "Packaging", zh: "包装费" },
  OTHER: { en: "Other charge", zh: "其他费用" },
};

/** Fees where "who bears it" is a usual open point when the text does not say. */
const BEARER_KINDS = new Set(["FREIGHT", "INSURANCE", "TAX_DUTY", "CUSTOMS_SERVICE", "PAYMENT_FEE", "PACKAGING", "OTHER"]);

const INTRO: Record<Lang, string> = {
  en: "Hello,\n\nThank you for your quotation. Before we go further, could you please clarify the following points:",
  zh: "您好！\n\n感谢贵方报价。在进一步沟通前，请就以下问题予以说明：",
};
const CLOSING: Record<Lang, string> = {
  en: "Nothing above is a confirmation of any term. We will review your reply before confirming anything.\n\nBest regards,",
  zh: "以上内容不构成对任何条款的确认。我方会在核对贵方回复后再确认相关条款。\n\n此致\n敬礼",
};

// ---------------------------------------------------------------- generation

function valueRefs(values: QuoteValue[]): ValueSourceRef[] {
  return values.map((v) => ({ path: v.path, runId: v.runId, source: v.source, versionNumber: v.versionNumber, review: v.review, reviewId: v.reviewId, usedFrom: v.usedFrom }));
}

function rowOrigin(r: ComparisonRow): QuestionOrigin {
  return {
    kind: "ROW",
    key: r.key,
    field: r.field,
    outcome: r.outcome as "DIFFERENCE" | "OPEN",
    note: { code: r.note.code, args: { ...r.note.args } },
    requestItemId: r.requestItemId,
    quoteItemIndex: r.quoteItemIndex,
    provisionalPairing: r.provisionalPairing,
    values: valueRefs(r.quote),
  };
}

function feeOrigin(f: FeeView): QuestionOrigin {
  return {
    kind: "FEE",
    key: `fee-${f.source}-${f.index}`,
    field: "fee",
    outcome: "OPEN",
    note: { code: f.status, args: { reasons: f.reasons.join(",") } },
    requestItemId: null,
    quoteItemIndex: null,
    provisionalPairing: false,
    values: valueRefs([f.kind, f.description, f.amount, f.basis, f.included, f.statedAs, f.payer]),
  };
}

type Texts = Record<Lang, string>;
type Built = { template: TemplateId; audience: Audience; texts: Texts; revealsBudget?: boolean } | "BUYER_CHECK" | null;

/** The value text a question may quote: the used value, else what the model wrote (never presented as agreed). */
const shown = (v: QuoteValue | undefined): string | null => (v ? (v.used ?? v.modelValue) : null);

function rowQuestion(r: ComparisonRow, itemName: string | null, quoteItemName: string | null, line: { quantity: number | null; unit: string | null } | null): Built {
  const a = r.note.args;
  const code = r.note.code;
  const item = itemName ? q(itemName) : null;
  const v = r.quote[0];
  // Points the buyer settles: pairing choice, own wording, own unreadable correction, supplement inheritance.
  if (["PAIRING_NEEDS_CHOICE", "PAIRING_CONFLICT", "REQUEST_WORDING_NOT_RECOGNISED", "CORRECTION_UNREADABLE", "INHERITANCE_UNRESOLVED", "SUPPLEMENT_ITEM_FIELD_NOT_STATED", "CANNOT_CHECK_TOTAL", "BUDGET_OTHER_CURRENCY"].includes(code)) {
    return "BUYER_CHECK";
  }
  const missing = ["NOT_STATED", "VALUE_UNREADABLE", "REJECTED_BY_USER", "QUOTE_WORDING_NOT_RECOGNISED"].includes(code);
  const readAs = (val: string | null): Texts =>
    code === "VALUE_UNREADABLE" && has(val) ? { en: ` As we read your quote, it shows ${q(val)}, which we could not read clearly.`, zh: `我方理解贵方报价写的是${q(val)}，但无法明确读取。` } : { en: "", zh: "" };

  switch (r.field) {
    case "material": {
      if (code === "DIFFERENT" && item && has(r.requestText) && has(shown(v))) {
        const want = q(r.requestText);
        const got = q(shown(v)!);
        return {
          template: "MATERIAL_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: our request specifies ${want}. As we read your quote, it states ${got}. Can you supply ${want}? If so, please state any change to the unit price and the lead time.`,
            zh: `商品${item}：我方需求为${want}。我方理解贵方报价写的是${got}。贵方能否提供${want}？如可以，请说明单价和交货期是否因此变化。`,
          },
        };
      }
      if (missing && item) {
        const want = has(r.requestText) ? q(r.requestText) : null;
        const extra = readAs(v?.modelValue ?? null);
        return {
          template: "ITEM_VALUE_MISSING",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: ${want ? `our request specifies ${want}. ` : ""}Please state the material grade you will supply.${extra.en}`,
            zh: `商品${item}：${want ? `我方需求为${want}。` : ""}请注明贵方将提供的材质等级。${extra.zh}`,
          },
        };
      }
      return null;
    }
    case "logo": {
      if (code === "DIFFERENT" && item && has(r.requestText) && has(shown(v))) {
        const want = q(r.requestText);
        const got = q(shown(v)!);
        return {
          template: "LOGO_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: our request asks for ${want}. As we read your quote, it states ${got}. Can you provide ${want}? If so, please state any price difference.`,
            zh: `商品${item}：我方需求为${want}。我方理解贵方报价写的是${got}。贵方能否按${want}提供？如可以，请说明价格差异。`,
          },
        };
      }
      if (missing && item) {
        const want = has(r.requestText) ? q(r.requestText) : null;
        return {
          template: "ITEM_VALUE_MISSING",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: ${want ? `our request asks for ${want}. ` : ""}Please state the logo method and the number of colours you will provide.`,
            zh: `商品${item}：${want ? `我方需求为${want}。` : ""}请注明贵方将采用的 Logo 工艺及颜色数量。`,
          },
        };
      }
      return null;
    }
    case "quantity": {
      if (code === "DIFFERENT" && item && line?.quantity !== null && line) {
        const want = qtyText(line.quantity!, line.unit);
        const got = a.quoted;
        return {
          template: "QUANTITY_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: our request is for ${want.en}. As we read your quote, the quantity is ${got}. Please confirm the quantity you are quoting for and, if it differs from our request, the revised line amount.`,
            zh: `商品${item}：我方需求数量为 ${want.zh}。我方理解贵方报价数量为 ${got}。请确认贵方报价对应的数量；如与我方需求不同，请提供修订后的该行金额。`,
          },
        };
      }
      if (code === "UNIT_DIFFERS" && item) {
        return {
          template: "UNIT_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: our request uses the unit ${q(a.wanted)}. As we read your quote, it uses ${q(a.quoted)}. Please confirm the unit and what ${q(a.quoted)} contains.`,
            zh: `商品${item}：我方需求单位为${q(a.wanted)}。我方理解贵方报价单位为${q(a.quoted)}。请确认计量单位，并说明${q(a.quoted)}所含内容。`,
          },
        };
      }
      if (missing && item) {
        const want = line?.quantity != null ? qtyText(line.quantity, line.unit) : null;
        return {
          template: "ITEM_VALUE_MISSING",
          audience: "SUPPLIER",
          texts: {
            en: `Item ${item}: please confirm the quantity you are quoting for${want ? ` (our request: ${want.en})` : ""}.`,
            zh: `商品${item}：请确认贵方报价对应的数量${want ? `（我方需求：${want.zh}）` : ""}。`,
          },
        };
      }
      return null;
    }
    case "unitPrice": {
      if (!item) return null;
      const extra = readAs(v?.modelValue ?? null);
      return {
        template: "ITEM_VALUE_MISSING",
        audience: "SUPPLIER",
        texts: { en: `Item ${item}: please state the unit price and its currency.${extra.en}`, zh: `商品${item}：请注明单价及币种。${extra.zh}` },
      };
    }
    case "specification": {
      if (!item || !has(r.requestText)) return null;
      return {
        template: "SPEC_CONFIRM",
        audience: "SUPPLIER_OPTIONAL",
        texts: {
          en: `Item ${item}: please confirm that the item you quote meets our specification ${q(r.requestText)}, and state any difference.`,
          zh: `商品${item}：请确认贵方所报商品符合我方规格要求${q(r.requestText)}，如有差异请说明。`,
        },
      };
    }
    case "pairing": {
      if (code === "NOT_QUOTED" && item) {
        const want = line?.quantity != null ? qtyText(line.quantity, line.unit) : null;
        return {
          template: "NOT_QUOTED",
          audience: "SUPPLIER",
          texts: {
            en: `Our request includes ${item}${want ? ` (${want.en})` : ""}. We could not find it in your quote. Please confirm whether you can quote it and, if so, the unit price and currency.`,
            zh: `我方需求包含${item}${want ? `（${want.zh}）` : ""}，但我方在贵方报价中未找到该商品。请确认能否报价；如可以，请注明单价及币种。`,
          },
        };
      }
      if (code === "EXTRA_QUOTE_ITEM" && has(quoteItemName)) {
        return {
          template: "EXTRA_QUOTE_ITEM",
          audience: "SUPPLIER",
          texts: {
            en: `As we read your quote, it includes ${q(quoteItemName)}, which is not in our request. Please explain what it is and whether it is charged separately.`,
            zh: `我方理解贵方报价包含${q(quoteItemName)}，该项不在我方需求中。请说明其内容以及是否单独收费。`,
          },
        };
      }
      return null;
    }
    case "currency": {
      if (code === "CURRENCY_DIFFERS") {
        return {
          template: "CURRENCY_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `As we read your quote, prices are in ${a.quoted}; our budget is set in ${a.wanted}. Please confirm the currency of your quote and whether you can also quote in ${a.wanted}.`,
            zh: `我方理解贵方报价币种为 ${a.quoted}；我方预算以 ${a.wanted} 计。请确认报价币种，并说明能否以 ${a.wanted} 报价。`,
          },
        };
      }
      if (code === "SEVERAL_CURRENCIES") {
        return {
          template: "SEVERAL_CURRENCIES",
          audience: "SUPPLIER",
          texts: {
            en: `As we read your quote, amounts appear in more than one currency (${a.list}). Please confirm the currency of every amount and of the total.`,
            zh: `我方理解贵方报价中的金额涉及多种币种（${a.list}）。请确认各项金额及总价的币种。`,
          },
        };
      }
      return { template: "CURRENCY_MISSING", audience: "SUPPLIER", texts: { en: "Please state the currency of the unit prices and of the total in your quote.", zh: "请注明报价中单价及总价的币种。" } };
    }
    case "budget": {
      if (code === "OVER_BUDGET") {
        return {
          template: "OVER_BUDGET",
          audience: "SUPPLIER_OPTIONAL",
          revealsBudget: true,
          texts: {
            en: `As we read your quote, the goods total is ${a.total}, which is above our budget of ${a.budget}. Is there any room to adjust the price?`,
            zh: `我方理解贵方报价的货款总额为 ${a.total}，高于我方预算 ${a.budget}。价格是否有调整空间？`,
          },
        };
      }
      return { template: "TOTAL_MISSING", audience: "SUPPLIER", texts: { en: "Please state the total amount of your quote and its currency.", zh: "请注明报价总金额及币种。" } };
    }
    case "arithmetic": {
      if (code !== "TOTAL_DIFFERS_FROM_LINES") return null;
      return {
        template: "TOTAL_DIFFERS",
        audience: "SUPPLIER",
        texts: {
          en: `As we read your quote, the unit prices multiplied by the quantities add up to ${a.sum}, but the stated total is ${a.total}. Please confirm the correct quantities and unit prices, and send the revised total.`,
          zh: `我方理解贵方报价中单价乘以数量合计为 ${a.sum}，但报价写明的总价为 ${a.total}。请确认正确的数量和单价，并提供修订后的总价。`,
        },
      };
    }
    case "incoterm":
    case "leadTime":
    case "paymentTerms":
      return termQuestion(r);
  }
  return null;
}

function termQuestion(r: ComparisonRow): Built {
  const a = r.note.args;
  const f = FIELD[r.field];
  const text = shown(r.quote[0]);
  const shipBy = a.shipBy ?? null;
  const ctx: Texts =
    r.field === "incoterm" && has(r.requestText)
      ? { en: ` (our request: ${q(r.requestText)})`, zh: `（我方需求：${q(r.requestText)}）` }
      : r.field === "leadTime" && has(r.requestText) && /^ship by \d{4}-\d{2}-\d{2}$/.test(r.requestText)
        ? { en: ` (we need shipment by ${r.requestText.slice(8)})`, zh: `（我方要求 ${r.requestText.slice(8)} 前发货）` }
        : r.field === "paymentTerms" && has(r.requestText)
          ? { en: ` (our proposal: ${q(r.requestText)})`, zh: `（我方提议：${q(r.requestText)}）` }
          : { en: "", zh: "" };
  switch (r.note.code) {
    case "NOT_AGREED":
      return {
        template: "TERM_NOT_AGREED",
        audience: "SUPPLIER",
        texts: {
          en: `${cap(f.en)}: as we read your quote, it says ${q(a.text)}. Please state the ${f.en} you propose${ctx.en}. Until it is agreed in writing, we treat this point as open.`,
          zh: `${f.zh}：我方理解贵方报价写的是${q(a.text)}。请说明贵方提出的${f.zh}${ctx.zh}。在书面约定前，我方将此项视为未约定。`,
        },
      };
    case "NOT_STATED":
    case "VALUE_UNREADABLE":
    case "REJECTED_BY_USER":
      return { template: "TERM_MISSING", audience: "SUPPLIER", texts: { en: `Please state the ${f.en} for this quote${ctx.en}.`, zh: `请注明本次报价的${f.zh}${ctx.zh}。` } };
    case "QUOTE_WORDING_NOT_RECOGNISED": {
      if (!has(text)) return { template: "TERM_MISSING", audience: "SUPPLIER", texts: { en: `Please state the ${f.en} for this quote${ctx.en}.`, zh: `请注明本次报价的${f.zh}${ctx.zh}。` } };
      const detail: Texts =
        r.field === "incoterm"
          ? { en: "the Incoterms rule and the named place", zh: "Incoterms 规则及指定地点" }
          : r.field === "leadTime"
            ? { en: "the number of days and from when they are counted", zh: "天数以及从何时起算" }
            : { en: "the deposit percentage, the balance and when each is due", zh: "定金比例、尾款以及各自的支付时间" };
      return {
        template: "TERM_UNCLEAR",
        audience: "SUPPLIER",
        texts: { en: `${cap(f.en)}: as we read your quote, it says ${q(text)}. Please state ${detail.en}${ctx.en}.`, zh: `${f.zh}：我方理解贵方报价写的是${q(text)}。请注明${detail.zh}${ctx.zh}。` },
      };
    }
    case "DIFFERENT": {
      if (r.field === "incoterm") {
        return {
          template: "INCOTERM_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `Trade term: our request asks for ${a.wanted}${has(r.requestText) ? ` (${q(r.requestText)})` : ""}. As we read your quote, it is on ${a.quoted} terms. Please confirm the trade term and, if you can offer ${a.wanted}, the price on that basis.`,
            zh: `贸易术语：我方需求为 ${a.wanted}${has(r.requestText) ? `（${q(r.requestText)}）` : ""}。我方理解贵方报价为 ${a.quoted} 条款。请确认贸易术语；如可按 ${a.wanted} 报价，请提供相应价格。`,
          },
        };
      }
      if (r.field === "paymentTerms" && has(r.requestText) && has(text)) {
        const want = parsePaymentTerms(r.requestText);
        const got = parsePaymentTerms(text);
        const pct: Texts =
          want && got && want.depositPercent !== got.depositPercent
            ? { en: ` (deposit ${got.depositPercent}% in your quote, ${want.depositPercent}% in our proposal)`, zh: `（贵方报价定金 ${got.depositPercent}%，我方提议定金 ${want.depositPercent}%）` }
            : { en: "", zh: "" };
        return {
          template: "PAYMENT_DIFFERS",
          audience: "SUPPLIER",
          texts: {
            en: `Payment terms: our proposal is ${q(r.requestText)}. As we read your quote, it states ${q(text)}${pct.en}. Please confirm the payment terms you propose.`,
            zh: `付款条件：我方提议为${q(r.requestText)}。我方理解贵方报价写的是${q(text)}${pct.zh}。请确认贵方提出的付款条件。`,
          },
        };
      }
      return null;
    }
    case "PARTIAL_TERMS":
      if (!has(text)) return null;
      return {
        template: "PAYMENT_PARTIAL",
        audience: "SUPPLIER",
        texts: { en: `Payment terms: as we read your quote, it states ${q(text)}. Please also state when the balance is due.`, zh: `付款条件：我方理解贵方报价写的是${q(text)}。请同时注明尾款的支付时间。` },
      };
    case "LEAD_TIME_TOO_LATE":
      return {
        template: "LEAD_TIME_TOO_LATE",
        audience: "SUPPLIER",
        texts: {
          en: `Lead time: we need shipment by ${shipBy}. As we read your quote, the lead time is ${q(text ?? "")} (${a.days} days after deposit). Please confirm whether shipment by ${shipBy} is possible.`,
          zh: `交货期：我方要求 ${shipBy} 前发货。我方理解贵方报价交货期为${q(text ?? "")}（定金后 ${a.days} 天）。请确认能否在 ${shipBy} 前发货。`,
        },
      };
    case "LEAD_TIME_START_UNCLEAR":
      return {
        template: "LEAD_TIME_START_UNCLEAR",
        audience: "SUPPLIER",
        texts: {
          en: `Lead time: as we read your quote, it is ${q(text ?? "")}. Please confirm from when it is counted (for example from receipt of the deposit or from sample approval) and whether shipment by ${shipBy} is possible.`,
          zh: `交货期：我方理解贵方报价交货期为${q(text ?? "")}。请确认交货期从何时起算（例如收到定金后或样品确认后），以及能否在 ${shipBy} 前发货。`,
        },
      };
    case "LEAD_TIME_APPROXIMATE":
      return {
        template: "LEAD_TIME_APPROXIMATE",
        audience: "SUPPLIER",
        texts: {
          en: `Lead time: as we read your quote, it is approximate (${q(text ?? "")}). Please confirm a firm lead time and whether shipment by ${shipBy} is possible.`,
          zh: `交货期：我方理解贵方报价交货期为约数（${q(text ?? "")}）。请确认确定的交货期，以及能否在 ${shipBy} 前发货。`,
        },
      };
  }
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function feeQuestion(f: FeeView): Built {
  const desc = shown(f.description) ?? null;
  const kind = (f.kind.used ?? "OTHER") as FeeKind;
  const label = FEE_KIND[kind] ?? FEE_KIND.OTHER;
  const name: Texts = desc && desc.trim().toLowerCase() !== label.en.toLowerCase() && desc.trim() !== label.zh ? { en: `${label.en} ${q(desc)}`, zh: `${label.zh}${q(desc)}` } : { en: label.en, zh: label.zh };
  if (f.status === "SUSPECTED_DUPLICATE") {
    const amt = shown(f.amount);
    return {
      template: "FEE_DUPLICATE",
      audience: "SUPPLIER_OPTIONAL",
      texts: {
        en: `As we read your quote, ${q(desc ?? label.en)}${has(amt) ? ` (${q(amt)})` : ""} is listed among the charges. Please confirm whether this is an additional charge or the goods price shown again.`,
        zh: `我方理解贵方报价在费用中列有${q(desc ?? label.zh)}${has(amt) ? `（${q(amt)}）` : ""}。请确认这是额外费用，还是货款的重复列示。`,
      },
    };
  }
  if (f.status !== "OPEN") return null;
  const parts: Texts[] = [];
  const reasons = new Set(f.reasons);
  const amountUsed = f.amount.used;
  if (reasons.has("AMOUNT_NOT_STATED")) parts.push({ en: "the amount and currency", zh: "金额及币种" });
  if (reasons.has("AMOUNT_OR_CURRENCY_UNCLEAR")) {
    const seen = f.amount.modelValue;
    parts.push(has(seen) ? { en: `the amount and currency (as we read your quote: ${q(seen)})`, zh: `金额及币种（我方理解贵方报价为${q(seen)}）` } : { en: "the amount and currency", zh: "金额及币种" });
  }
  if (reasons.has("PER_UNIT_NOT_ALLOCATED")) {
    parts.push({ en: "which items it applies to and the quantity it is charged on", zh: "适用于哪些商品以及按多少数量计费" });
    parts.push(
      f.included.used === "NOT_INCLUDED"
        ? { en: "whether it comes on top of the item prices (as we read your quote, it is not included in them)", zh: "是否在商品单价之外另计（我方理解为未包含在单价中）" }
        : f.included.used === "INCLUDED"
          ? { en: "whether it is already included in the item prices (as we read your quote, it is)", zh: "是否已包含在商品单价中（我方理解为已包含）" }
          : { en: "whether it is included in the item prices", zh: "是否已包含在商品单价中" },
    );
  }
  if (reasons.has("BASIS_UNKNOWN")) parts.push({ en: "whether it is charged per unit or per order", zh: "按件计费还是按单计费" });
  if (reasons.has("INCLUSION_UNKNOWN")) parts.push({ en: "whether it is included in the quoted price", zh: "是否已包含在报价中" });
  if (reasons.has("NOT_FIRM")) parts.push({ en: "whether the amount is firm or an estimate", zh: "该金额为确定价格还是估算" });
  if (f.payer.used === null && BEARER_KINDS.has(kind)) parts.push({ en: "who bears it", zh: "由哪方承担" });
  if (parts.length === 0) return null;
  const perUnit: Texts =
    reasons.has("PER_UNIT_NOT_ALLOCATED") && amountUsed ? { en: ` As we read your quote, it is ${amountUsed} per unit.`, zh: `我方理解贵方报价为按件计 ${amountUsed}。` } : { en: "", zh: "" };
  return {
    template: "FEE_OPEN",
    audience: "SUPPLIER",
    texts: {
      en: `${name.en}:${perUnit.en} Please state the following: ${parts.map((p) => p.en).join("; ")}.`,
      zh: `${name.zh}：${perUnit.zh}请说明以下内容：${parts.map((p) => p.zh).join("；")}。`,
    },
  };
}

/**
 * Questions for a comparison. Deterministic: the same comparison gives the same ids and texts. Questions
 * whose template, texts and item line are identical are merged (all origins kept); questions about other
 * items, currencies or versions never merge because their texts or lines differ.
 */
export function generateDraft(c: Comparison): GeneratedDraft {
  const lines = new Map(c.requestLines.map((l) => [l.id, l] as const));
  const pairingName = new Map(c.pairings.map((p) => [`${p.source}-${p.quoteItemIndex}`, p.quoteItemName] as const));
  const questions: DraftQuestion[] = [];
  const buyerChecks: BuyerCheck[] = [];
  const add = (built: Built, origin: QuestionOrigin, field: string, requestItemId: string | null, itemName: string | null) => {
    if (built === null) return;
    if (built === "BUYER_CHECK") {
      buyerChecks.push({ id: `CHECK:${origin.key}`, field, itemName, origin });
      return;
    }
    const twin = questions.find((x) => x.template === built.template && x.requestItemId === requestItemId && x.en === built.texts.en && x.zh === built.texts.zh);
    if (twin) {
      twin.origins.push(origin);
      return;
    }
    questions.push({
      id: `${built.template}:${origin.key}`,
      template: built.template,
      audience: built.audience,
      outcome: origin.outcome,
      field,
      requestItemId,
      itemName,
      revealsBudget: built.revealsBudget === true,
      en: built.texts.en,
      zh: built.texts.zh,
      origins: [origin],
    });
  };

  for (const r of c.rows) {
    if (r.outcome === "MATCH") continue;
    const line = r.requestItemId ? (lines.get(r.requestItemId) ?? null) : null;
    const itemName = line?.name ?? null;
    const source = r.quote[0]?.source ?? "THIS_VERSION";
    const quoteItemName = r.quoteItemIndex !== null ? (pairingName.get(`${source}-${r.quoteItemIndex}`) ?? null) : null;
    add(rowQuestion(r, itemName, quoteItemName, line), rowOrigin(r), r.field, r.requestItemId, itemName);
  }
  for (const f of c.fees) {
    if (f.status !== "OPEN" && f.status !== "SUSPECTED_DUPLICATE") continue;
    add(feeQuestion(f), feeOrigin(f), "fee", null, null);
  }
  for (const x of questions) assertPaired(x);
  return { templateVersion: CLARIFICATION_TEMPLATE_VERSION, questions, buyerChecks, intro: { ...INTRO }, closing: { ...CLOSING } };
}

/** A template bug (one language carrying a value the other does not) must never reach a draft. */
function assertPaired(x: DraftQuestion): void {
  const en = extractTokens(x.en);
  const zh = extractTokens(x.zh);
  const a = [...new Set(en.tokens.map((t) => t.key))].sort().join("|");
  const b = [...new Set(zh.tokens.map((t) => t.key))].sort().join("|");
  if (a !== b) throw new Error(`clarification template ${x.template} is not paired: en [${a}] vs zh [${b}]`);
}

// ---------------------------------------------------------------- draft content

export interface LangText {
  intro: string;
  closing: string;
  /** Text per question id, for every generated question (selected or not), so a deselected edit is kept. */
  questions: Record<string, string>;
}

export interface DraftContent {
  /** Question ids included in the message, in the order of the generated list. */
  selected: string[];
  en: LangText;
  zh: LangText;
}

export function initialContent(g: GeneratedDraft): DraftContent {
  const texts = (lang: Lang): LangText => ({ intro: g.intro[lang], closing: g.closing[lang], questions: Object.fromEntries(g.questions.map((x) => [x.id, x[lang]])) });
  return { selected: g.questions.filter((x) => x.audience === "SUPPLIER").map((x) => x.id), en: texts("en"), zh: texts("zh") };
}

export const CONTENT_LIMITS = { textChars: 2000, totalBytes: 96 * 1024 } as const;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Shape and limits of a content object sent by the browser. Texts are free; ids must be the draft's own. */
export function validateContent(value: unknown, g: GeneratedDraft): { ok: true; content: DraftContent } | { ok: false; message: string } {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(value)) return { ok: false, message: "content must be an object." };
  const extra = Object.keys(value).filter((k) => !["selected", "en", "zh"].includes(k));
  if (extra.length > 0) return { ok: false, message: `Unknown content field(s): ${extra.join(", ")}.` };
  const ids = g.questions.map((x) => x.id);
  if (!Array.isArray(value.selected) || !value.selected.every((s) => typeof s === "string")) return { ok: false, message: "selected must be a list of question ids." };
  const selected = value.selected as string[];
  if (new Set(selected).size !== selected.length) return { ok: false, message: "A question is selected twice." };
  const unknown = selected.filter((s) => !ids.includes(s));
  if (unknown.length > 0) return { ok: false, message: "Only questions of this draft can be selected." };
  const out: Partial<DraftContent> = { selected: ids.filter((id) => selected.includes(id)) };
  for (const lang of LANGS) {
    const t = value[lang];
    if (!isObj(t)) return { ok: false, message: `${lang} texts are missing.` };
    const tExtra = Object.keys(t).filter((k) => !["intro", "closing", "questions"].includes(k));
    if (tExtra.length > 0) return { ok: false, message: `Unknown ${lang} field(s): ${tExtra.join(", ")}.` };
    const textOk = (s: unknown): s is string => typeof s === "string" && [...s].length <= CONTENT_LIMITS.textChars && !CONTROL.test(s) && s.isWellFormed();
    if (!textOk(t.intro) || !textOk(t.closing)) return { ok: false, message: `${lang} opening / closing: up to ${CONTENT_LIMITS.textChars} characters, no control characters.` };
    if (!isObj(t.questions)) return { ok: false, message: `${lang} question texts are missing.` };
    const keys = Object.keys(t.questions);
    if (keys.length !== ids.length || !ids.every((id) => keys.includes(id))) return { ok: false, message: `${lang} must have a text for every question of this draft, and no other.` };
    if (!Object.values(t.questions).every(textOk)) return { ok: false, message: `${lang} question texts: up to ${CONTENT_LIMITS.textChars} characters each, no control characters.` };
    out[lang] = { intro: t.intro, closing: t.closing, questions: Object.fromEntries(ids.map((id) => [id, (t.questions as Record<string, string>)[id]])) };
  }
  const content = out as DraftContent;
  if (new TextEncoder().encode(JSON.stringify(content)).length > CONTENT_LIMITS.totalBytes) return { ok: false, message: "The draft is too long." };
  return { ok: true, content };
}

/** Stable serialisation (key order fixed) used for change detection and hashing. */
export function contentKey(c: DraftContent): string {
  const lang = (t: LangText) => [t.intro, t.closing, Object.keys(t.questions).sort().map((k) => [k, t.questions[k]])];
  return JSON.stringify([c.selected, lang(c.en), lang(c.zh)]);
}

/**
 * Copy format (28 Oct). Each copied question carries its list number AND its fixed draft number, e.g.
 * "2. [Q3] …", and the message ends with the draft reference, so a supplier's "Q3" can be traced back to THIS
 * draft. Q numbers are scoped to one draft: nothing matches replies to questions by "Q3" automatically.
 * Saved revisions are not rewritten; the format applies to text copied from now on.
 */
export const COPY_FORMAT = "copy-2026-10-28.1";

/** "CD-1A2B3C4D". Display / message reference only. */
export function shortDraftRef(draftId: string): string {
  return `CD-${draftId.replace(/^cd_/, "").slice(0, 8).toUpperCase()}`;
}

const REF_LINE: Record<Lang, (ref: string) => string> = {
  en: (ref) => `Reference: ${ref} (Q numbers refer to the questions in this message).`,
  zh: (ref) => `参考编号：${ref}（Q 编号仅指本消息中的问题）。`,
};

/** The message as it would be copied: opening, numbered selected questions with their Q numbers, closing, reference. */
export function assemble(c: DraftContent, lang: Lang, g: Pick<GeneratedDraft, "questions">, draftId: string): string {
  const t = c[lang];
  const qn = (id: string) => g.questions.findIndex((q) => q.id === id) + 1;
  const list = c.selected.map((id, i) => `${i + 1}. [Q${qn(id)}] ${t.questions[id].trim()}`);
  return [t.intro.trim(), list.join("\n"), t.closing.trim(), REF_LINE[lang](shortDraftRef(draftId))].filter((s) => s !== "").join("\n\n");
}

// ---------------------------------------------------------------- deterministic check

export type TokenKind = "REF" | "MONEY" | "QUANTITY" | "MEASURE" | "PERCENT" | "NUMBER" | "CODE" | "DATE" | "INCOTERM" | "CURRENCY" | "BASIS";

export interface Token {
  key: string;
  kind: TokenKind;
  /** As written in the text. */
  label: string;
}

export interface Extracted {
  tokens: Token[];
  /** Parts the rules cannot read with certainty (ambiguous number or date format, bare $ / ¥, numbers in words). */
  unreadable: string[];
}

const QUOTES = /“([^“”]*)”|「([^「」]*)」|"([^"]*)"/g;
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const ZH_DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
const AMBIGUOUS_DATE = /(?<![\d.])\d{1,2}[/.]\d{1,2}[/.]\d{2,4}(?![\d.])/g;
const WORD_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/gi;
const INCOTERM = /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/g;
const AMBIGUOUS_SYMBOL = /(?<![A-Za-z])\$|[¥￥]/g;
const EN_NUMBER_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half|double|twice|percent)\b/gi;
const ZH_NUMERALS = /百分之[〇零一二两三四五六七八九十百千]+|[〇零一二两三四五六七八九十百千万]+(?=\s*(?:个|件|套|只|台|箱|盒|瓶|双|打|天|日|周|年|月|元|美元|人民币|成|倍|%))|[一二两三四五六七八九][十百千万]/g;
const BASIS_WORDS: [RegExp, string][] = [
  [/\bper[ -](?:unit|piece|pc|pcs|item|set|bottle)\b|按件|每件|每个|每只|每套|按个/gi, "PER_UNIT"],
  [/\bper[ -](?:order|shipment|consignment)\b|\blump[ -]sum\b|按单|每单|整单|每票|一次性/gi, "PER_ORDER"],
];

const COUNT_GROUPS: [RegExp, string][] = [
  [/^(?:pcs?|pieces?|units?|ea|个|只|件|支|把)$/i, "piece"],
  [/^(?:sets?|套)$/i, "set"],
  [/^(?:box(?:es)?|盒)$/i, "box"],
  [/^(?:cartons?|ctns?|箱)$/i, "carton"],
  [/^(?:pairs?|双)$/i, "pair"],
  [/^(?:bottles?|瓶)$/i, "bottle"],
];
const MEASURE_GROUPS: [RegExp, string][] = [
  [/^(?:days?|天|日)$/i, "day"],
  [/^(?:weeks?|周)$/i, "week"],
  [/^(?:months?|个月|月)$/i, "month"],
  [/^(?:years?|年)$/i, "year"],
  [/^(?:hours?|hrs?|小时)$/i, "hour"],
  [/^(?:ml|millilit(?:re|er)s?|毫升)$/i, "ml"],
  [/^(?:l|ltr|lit(?:re|er)s?|升)$/i, "l"],
  [/^(?:kg|千克|公斤)$/i, "kg"],
  [/^(?:g|grams?|克)$/i, "g"],
  [/^(?:mm|毫米)$/i, "mm"],
  [/^(?:cm|厘米)$/i, "cm"],
  [/^(?:m|米)$/i, "m"],
];
const group = (groups: [RegExp, string][], unit: string | null) => (unit === null ? "" : (groups.find(([re]) => re.test(unit))?.[1] ?? unit.toLowerCase()));

/** Exact decimal text of a reading without trailing zeros ("11760.00" → "11760", "1.20" → "1.2"). */
function decimal(r: Reading): string {
  let s = r.digits.toString();
  if (r.scale > 0) {
    s = s.padStart(r.scale + 1, "0");
    s = `${s.slice(0, -r.scale)}.${s.slice(-r.scale)}`.replace(/\.?0+$/, "");
  }
  return s.replace(/^0+(?=\d)/, "");
}

const refNorm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** The values a piece of text carries, as the check compares them. */
export function extractTokens(text: string): Extracted {
  const tokens: Token[] = [];
  const unreadable: string[] = [];
  let rest = text.replace(QUOTES, (m, a: string | undefined, b: string | undefined, c: string | undefined) => {
    const inner = a ?? b ?? c ?? "";
    tokens.push({ key: `R:${refNorm(inner)}`, kind: "REF", label: `“${inner}”` });
    return " ";
  });
  if (/[“”「」"]/.test(rest)) unreadable.push("unbalanced quotation mark");
  const blank = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    rest = rest.replace(re, (...args) => {
      const m = args as unknown as RegExpExecArray;
      fn(m);
      return " ";
    });
  };
  blank(ISO_DATE, (m) => tokens.push({ key: `D:${m[1]}-${m[2]}-${m[3]}`, kind: "DATE", label: m[0] }));
  blank(ZH_DATE, (m) => tokens.push({ key: `D:${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`, kind: "DATE", label: m[0] }));
  blank(AMBIGUOUS_DATE, (m) => unreadable.push(`${m[0]} (date format not stated)`));
  blank(WORD_DATE, (m) => unreadable.push(`${m[0]} (date in words)`));
  for (const m of rest.matchAll(INCOTERM)) tokens.push({ key: `I:${m[1]}`, kind: "INCOTERM", label: m[1] });
  for (const [re, basis] of BASIS_WORDS) for (const m of rest.matchAll(re)) tokens.push({ key: `B:${basis}`, kind: "BASIS", label: m[0] });
  for (const m of rest.matchAll(EN_NUMBER_WORDS)) unreadable.push(`${m[0]} (number in words)`);
  for (const m of rest.matchAll(ZH_NUMERALS)) unreadable.push(`${m[0]} (number in Chinese numerals)`);
  for (const m of rest.matchAll(AMBIGUOUS_SYMBOL)) unreadable.push(`${m[0]} (currency symbol without a code)`);
  for (const cur of currenciesIn(rest)) tokens.push({ key: `CUR:${cur}`, kind: "CURRENCY", label: cur });
  for (const n of scanNumbers(rest)) {
    if (n.readings.length !== 1 || n.ambiguousFormat) {
      unreadable.push(`${n.raw} (number format is ambiguous)`);
      continue;
    }
    const value = decimal(n.readings[0]);
    switch (n.role) {
      case "MONEY":
        if (n.currency === "AMBIGUOUS" || n.currency === null) unreadable.push(`${n.raw} (currency unclear)`);
        else tokens.push({ key: `M:${n.currency}:${value}`, kind: "MONEY", label: `${n.currency} ${n.raw}` });
        break;
      case "COUNT":
        tokens.push({ key: `Q:${value}:${group(COUNT_GROUPS, n.unit)}`, kind: "QUANTITY", label: `${n.raw} ${n.unit ?? ""}`.trim() });
        break;
      case "MEASURE":
        tokens.push({ key: `U:${value}:${group(MEASURE_GROUPS, n.unit)}`, kind: "MEASURE", label: `${n.raw} ${n.unit ?? ""}`.trim() });
        break;
      case "PERCENT":
        tokens.push({ key: `P:${value}`, kind: "PERCENT", label: `${n.raw}%` });
        break;
      case "CODE":
        tokens.push({ key: `C:${n.normalized}`, kind: "CODE", label: n.raw });
        break;
      default:
        tokens.push({ key: `N:${value}`, kind: "NUMBER", label: n.raw });
    }
  }
  return { tokens, unreadable };
}

/** INCONSISTENT = a value differs; REVIEW = rules could not decide or the wording was edited; NONE_FOUND = nothing found by these rules. */
export type PartStatus = "INCONSISTENT" | "REVIEW" | "NONE_FOUND";

export type FindingCode =
  | "EMPTY" // no text in this language
  | "MISSING" // a value from the comparison is in the other language but not in this one
  | "MISSING_BOTH" // a value from the comparison is in neither language
  | "CHANGED" // this language has a different value of the same kind where the comparison's value was
  | "ADDED" // a value only in this language, not from the comparison
  | "ADDED_BOTH" // the same value in both languages, but not from the comparison (cannot be traced)
  | "UNREADABLE" // the rules cannot read this part with certainty
  | "EDITED"; // wording changed from the template: meaning is not checked

export interface Finding {
  code: FindingCode;
  lang: Lang | "both";
  kind: TokenKind | null;
  expected: string | null;
  found: string | null;
}

export interface PartCheck {
  /** "intro", "closing" or a question id. */
  id: string;
  status: PartStatus;
  findings: Finding[];
}

export interface DraftCheck {
  rules: string;
  /** contentKey() of what was checked: any later edit makes this result out of date. */
  checkedKey: string;
  overall: PartStatus | "NOTHING_SELECTED";
  parts: PartCheck[];
  counts: Record<PartStatus, number>;
}

const INCONSISTENT_CODES: FindingCode[] = ["EMPTY", "MISSING", "MISSING_BOTH", "CHANGED", "ADDED"];

/** Check one part (a question, the opening or the closing): both languages against the generated texts. */
export function checkPart(id: string, initial: Record<Lang, string>, now: Record<Lang, string>): PartCheck {
  const findings: Finding[] = [];
  const expected = new Map<string, Token>();
  for (const t of extractTokens(initial.en).tokens) if (!expected.has(t.key)) expected.set(t.key, t);
  const got: Record<Lang, Map<string, Token>> = { en: new Map(), zh: new Map() };
  for (const lang of LANGS) {
    if (now[lang].trim() === "" && initial[lang].trim() !== "") findings.push({ code: "EMPTY", lang, kind: null, expected: null, found: null });
    const ex = extractTokens(now[lang]);
    for (const t of ex.tokens) if (!got[lang].has(t.key)) got[lang].set(t.key, t);
    for (const u of ex.unreadable) findings.push({ code: "UNREADABLE", lang, kind: null, expected: null, found: u });
    if (now[lang] !== initial[lang]) findings.push({ code: "EDITED", lang, kind: null, expected: null, found: null });
  }
  const missing: Record<Lang, Token[]> = { en: [], zh: [] };
  const extra: Record<Lang, Token[]> = { en: [], zh: [] };
  for (const lang of LANGS) {
    for (const [k, t] of expected) if (!got[lang].has(k)) missing[lang].push(t);
    for (const [k, t] of got[lang]) if (!expected.has(k)) extra[lang].push(t);
    // A missing value and an extra value of the same kind in one language: the value was changed.
    for (const m of [...missing[lang]]) {
      const e = extra[lang].find((x) => x.kind === m.kind);
      if (!e) continue;
      findings.push({ code: "CHANGED", lang, kind: m.kind, expected: m.label, found: e.label });
      missing[lang].splice(missing[lang].indexOf(m), 1);
      extra[lang].splice(extra[lang].indexOf(e), 1);
    }
  }
  for (const lang of LANGS) {
    const other: Lang = lang === "en" ? "zh" : "en";
    for (const m of missing[lang]) {
      const alsoOther = missing[other].some((x) => x.key === m.key);
      if (alsoOther && lang === "zh") continue; // reported once
      findings.push({ code: alsoOther ? "MISSING_BOTH" : "MISSING", lang: alsoOther ? "both" : lang, kind: m.kind, expected: m.label, found: null });
    }
    for (const e of extra[lang]) {
      const alsoOther = extra[other].some((x) => x.key === e.key);
      if (alsoOther && lang === "zh") continue;
      findings.push({ code: alsoOther ? "ADDED_BOTH" : "ADDED", lang: alsoOther ? "both" : lang, kind: e.kind, expected: null, found: e.label });
    }
  }
  const status: PartStatus = findings.some((f) => INCONSISTENT_CODES.includes(f.code)) ? "INCONSISTENT" : findings.length > 0 ? "REVIEW" : "NONE_FOUND";
  return { id, status, findings };
}

/** Check the selected questions plus the opening and closing. Never says "verified": see the module header. */
export function checkDraft(content: DraftContent, initial: DraftContent): DraftCheck {
  const parts: PartCheck[] = [];
  const pick = (c: DraftContent, f: (t: LangText) => string): Record<Lang, string> => ({ en: f(c.en), zh: f(c.zh) });
  parts.push(checkPart("intro", pick(initial, (t) => t.intro), pick(content, (t) => t.intro)));
  for (const id of content.selected) {
    parts.push(checkPart(id, pick(initial, (t) => t.questions[id] ?? ""), pick(content, (t) => t.questions[id] ?? "")));
  }
  parts.push(checkPart("closing", pick(initial, (t) => t.closing), pick(content, (t) => t.closing)));
  const counts: Record<PartStatus, number> = { INCONSISTENT: 0, REVIEW: 0, NONE_FOUND: 0 };
  for (const p of parts) counts[p.status] += 1;
  const overall: DraftCheck["overall"] = content.selected.length === 0 ? "NOTHING_SELECTED" : counts.INCONSISTENT > 0 ? "INCONSISTENT" : counts.REVIEW > 0 ? "REVIEW" : "NONE_FOUND";
  return { rules: BILINGUAL_CHECK_RULES, checkedKey: contentKey(content), overall, parts, counts };
}
