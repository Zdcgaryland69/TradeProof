// Validator for a Copilot explanation (2 Nov; plan §5). The explanation is shown only if ALL checks pass; otherwise it
// is dropped with the reasons and the facts layer stays. Passing proves consistency with the facts (citations exist,
// numbers and state words are backed by cited trusted facts, no action claims, no URLs, blocking items not dropped) —
// it does NOT prove the explanation is right. A person reviews it.

import { COPILOT_LIMITS, type CopilotFact, type CopilotIntent, type CopilotLink, type FactTag } from "../../lib/copilot.ts";

export const COPILOT_VALIDATOR_VERSION = "copilot-validator-2026-11-02.5";

export type Validated = { ok: true; sentences: { text: string; facts: string[] }[]; nextStep: string | null } | { ok: false; problems: string[] };

const NUMBER = /\d(?:[\d,]*\d)?(?:\.\d+)?/g;
const IDS = /\b[FL]\d{1,3}\b/g;

/** "1,700.00" → "1700", "12.50" → "12.5", "007" → "7". Numbers are compared as values, not text. */
export function normaliseNumber(s: string): string {
  let n = s.replace(/,/g, "");
  if (n.includes(".")) n = n.replace(/0+$/, "").replace(/\.$/, "");
  n = n.replace(/^0+(?=\d)/, "");
  return n;
}

export function numbersIn(text: string): string[] {
  return [...text.normalize("NFKC").replace(IDS, " ").matchAll(NUMBER)].map((m) => normaliseNumber(m[0]));
}

const URL_OR_EMAIL = /\b(?:https?:\/\/|www\.)|[\w.+-]+@[\w-]+\.[\w.]+|\/procurements\//i;

/** Claims of having acted, or advice to get past a block. */
const ACTION_CLAIMS: RegExp[] = [
  /\b(?:i|we)\s+(?:have\s+|'ve\s+|has\s+)?(?:just\s+)?(?:approved|paid|sent|notified|e-?mailed|confirmed|accepted|changed|updated|saved|marked|captured|submitted|recorded|assigned)\b/i,
  /\b(?:i|we)\s+(?:will|can|'ll)\s+(?:now\s+)?(?:approve|pay|send|notify|e-?mail|confirm|accept|change|update|save|mark|capture|submit|assign)\b/i,
  /\b(?:payment|money|funds)\s+(?:has\s+been|have\s+been|was|were|is)\s+(?:sent|made|captured|transferred|completed)\b/i,
  /\b(?:supplier|seller)\s+(?:has\s+been|was)\s+(?:notified|informed|told|paid)\b/i,
  // Advice to get past a block ("confirm and ignore the blocking items", "override the block"). Only connector words may
  // stand between the verb and "block", so TradeProof's own wording ("must confirm each listed item (0 blocking …)") passes.
  /\b(?:confirm|override|ignore|bypass|skip|dismiss)\b(?:\s+(?:and|or|then|past|through|around|over|the|any|all|these|this|those|every|confirm|override|ignore|bypass|skip|dismiss)){0,5}\s+block/i,
];

/** State words → a cited fact must carry one of these tags (positive claims need the exact state). */
const STATE_WORDS: { re: RegExp; tags: FactTag[]; label: string }[] = [
  { re: /\b(?:has|have|was|were|is|are)\s+(?:been\s+|now\s+|already\s+)?approved\b/i, tags: ["APPROVAL_ACTIVE"], label: "approved" },
  { re: /\b(?:has|have|was|were|is|are)\s+(?:been\s+|now\s+|already\s+)?paid\b/i, tags: ["PAID"], label: "paid" },
  // v1 (owner, 2 Nov night): no unconditional "you can pay now" — not even with an Active approval (role, payment switch
  // and payment state also decide). No fact carries PAYABLE_NOW, so such a sentence always fails; conditional or negative
  // sentences ("only when …", "cannot …", "not payable now") are exempt below.
  { re: /\b(?:(?:can|may|could|able to|ready to|free to)\s+(?:now\s+|already\s+|directly\s+|immediately\s+)?(?:be\s+)?(?:pay|paid|start (?:the |a )?(?:sandbox )?payment|make (?:the |a )?payment)|ready (?:for|to be) (?:paid|payment)|payable now|can be paid)\b/i, tags: ["PAYABLE_NOW"], label: "payable now" },
  { re: /\bblock(?:ed|s|ing)?\b/i, tags: ["BLOCK", "GATE", "GATE_BLOCKED"], label: "blocked" },
  { re: /\bready\b/i, tags: ["GATE", "GATE_READY"], label: "ready" },
  { re: /\bapprov(?:e|ed|al|als|er|ing)\b/i, tags: ["GATE", "APPROVAL", "ROLE", "NEXT_STEP"], label: "approval" },
  { re: /\bactive\b/i, tags: ["APPROVAL", "APPROVAL_ACTIVE", "NEXT_STEP"], label: "active" },
  { re: /\b(?:paid|payment|pay)\b/i, tags: ["PAYMENT", "PAID", "AMOUNT", "ROLE", "NEXT_STEP"], label: "payment" },
  { re: /\b(?:no longer valid|invalid(?:ated)?|revoked)\b/i, tags: ["APPROVAL"], label: "validity" },
  { re: /\b(?:answered|unanswered|open|resolved|unresolved)\b/i, tags: ["QUESTION", "DIFFERENCE", "DRAFT", "NOT_AVAILABLE", "NEXT_STEP"], label: "question state" },
];

// ---- narrow exceptions (owner, 2 Nov re-validation). Keyword rules cannot reliably understand English: anything outside
// these exact shapes stays rejected, and meaning is still checked by a person. ----

/** Fee parties as written in fee facts ("paid to CARRIER", "payer BUYER") and the words a sentence may use for them. */
const PARTY_WORDS: Record<string, RegExp> = {
  BUYER: /^(?:the\s+)?buyer\b/i,
  SUPPLIER: /^(?:the\s+)?(?:supplier|seller)\b/i,
  CARRIER: /^(?:the\s+)?(?:carrier|forwarder|freight forwarder)\b/i,
  INSURER: /^(?:the\s+)?insurer\b/i,
  GOVERNMENT: /^(?:the\s+)?(?:government|customs authority|tax authority)\b/i,
  CUSTOMS_BROKER: /^(?:the\s+)?customs broker\b/i,
  PAYMENT_PROVIDER: /^(?:the\s+)?(?:payment provider|bank)\b/i,
};
/** Present tense only: "is / are paid to | by <party>". Past or perfect tense ("was paid", "has been paid") never qualifies. */
const FEE_ROLE_PHRASE = /\b(?:is|are)\s+paid\s+(to|by)\s+([^,.;]+)/gi;

/**
 * A sentence may describe who pays / receives a FEE ("they are paid to the government") when a cited trusted fee fact
 * states exactly that party ("paid to GOVERNMENT" / "payer BUYER"). Returns the sentence with those phrases removed (so
 * any OTHER paid / completion claim in it is still checked), or null when a phrase does not match a cited fee fact.
 */
function withoutFeeRolePhrases(t: string, feeFacts: CopilotFact[]): string | null {
  let rest = t;
  for (const m of t.matchAll(FEE_ROLE_PHRASE)) {
    const dir = m[1].toLowerCase();
    const hit = Object.entries(PARTY_WORDS)
      .map(([party, re]) => ({ party, words: re.exec(m[2])?.[0] ?? null }))
      .find((x) => x.words !== null);
    if (!hit) return null;
    const stated = feeFacts.some((f) => (dir === "to" ? new RegExp(`paid to ${hit.party}\\b`).test(f.text) : new RegExp(`payer ${hit.party}\\b`).test(f.text)));
    if (!stated) return null;
    // Remove only "is / are paid to | by <party words>" — never the rest of the clause, which is still checked.
    rest = rest.replace(m[0].slice(0, m[0].length - m[2].length) + hit.words, " ");
  }
  return rest;
}

/**
 * The system rule "answered ≠ approved" (a RULE fact) may back a question-state word only in a GENERAL boundary
 * sentence: it names no particular question (a "Q1" also fails the number check) and states that answering does not
 * approve. It never backs "Q1 is answered", "Q2 is resolved" or "… is approved".
 */
const GENERAL_RULE_SENTENCE = /\b(?:does not|doesn't|do not|don't|never|is not|isn't)\s+(?:\w+\s+){0,3}approv/i;
const NAMES_A_QUESTION = /\bQ\d+\b|\b(?:quantity|arithmetic|price|material|logo|specification|currency|incoterm|lead time|payment terms|fee)\s+question\b/i;

/** The rule's own phrasing; a question-state word backed only by the rule must sit inside one of these. */
const RULE_PHRASE = /\b(?:an?|any|each)\s+answered\s+question\b|\ba\s+question\s+(?:that\s+is\s+|marked\s+(?:as\s+)?)answered\b|\banswering\s+(?:a|the|any)\s+question\b/gi;
const QUESTION_STATE = /\b(?:answered|unanswered|open|resolved|unresolved)\b/i;
/** "Not all resolved" / "still open": the negation must apply to the resolved claim itself (2 Nov fix: "not" anywhere used to exempt). */
const NEGATED_RESOLVED = /\b(?:not|n't)\s+(?:\w+\s+){0,2}(?:all\s+|every\w*\s+)?(?:resolved|answered|settled|clear(?:ed)?|closed)\b|\bnot\s+(?:all|every|everything)\b|\bstill\s+(?:open|unresolved)\b/i;

const ALL_RESOLVED = /\b(?:all|every|everything|nothing)\b[^.]{0,60}\b(?:resolved|answered|settled|clear(?:ed)?|closed|left|open)\b/i;

export function validateExplanation(raw: string, ctx: { intent: CopilotIntent; facts: CopilotFact[]; links: CopilotLink[] }): Validated {
  const problems: string[] = [];
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["NOT_JSON"] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problems: ["NOT_AN_OBJECT"] };
  const o = value as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "sentences" && k !== "nextStep");
  if (extra.length) problems.push(`UNKNOWN_KEYS:${extra.join(",")}`);
  if (!Array.isArray(o.sentences) || o.sentences.length < 1 || o.sentences.length > COPILOT_LIMITS.maxSentences) return { ok: false, problems: [...problems, "SENTENCES_COUNT"] };
  const nextStep = o.nextStep === undefined ? null : o.nextStep;
  if (nextStep !== null && (typeof nextStep !== "string" || !ctx.links.some((l) => l.id === nextStep))) problems.push("NEXT_STEP_NOT_A_LINK_ID");

  const byId = new Map(ctx.facts.map((f) => [f.id, f] as const));
  const unresolvedInBundle = ctx.facts.some((f) => f.tags.includes("Q_UNRESOLVED") || f.tags.includes("DIFFERENCE") || f.tags.includes("BLOCK"));
  const cited = new Set<string>();
  const sentences: { text: string; facts: string[] }[] = [];
  o.sentences.forEach((s: unknown, i: number) => {
    const n = i + 1;
    if (!s || typeof s !== "object" || Array.isArray(s)) return void problems.push(`S${n}:SHAPE`);
    const so = s as Record<string, unknown>;
    if (Object.keys(so).some((k) => k !== "text" && k !== "facts")) problems.push(`S${n}:UNKNOWN_KEYS`);
    if (typeof so.text !== "string" || so.text.trim() === "" || [...so.text].length > COPILOT_LIMITS.maxSentenceChars) return void problems.push(`S${n}:TEXT`);
    if (!Array.isArray(so.facts) || so.facts.length < 1 || so.facts.length > COPILOT_LIMITS.maxCitationsPerSentence || so.facts.some((x) => typeof x !== "string")) return void problems.push(`S${n}:NO_CITATION`);
    const t = so.text;
    const ids = so.facts as string[];
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return void problems.push(`S${n}:UNKNOWN_FACT:${missing.join(",")}`);
    const citedFacts = ids.map((id) => byId.get(id)!);
    ids.forEach((id) => cited.add(id));

    // Numbers: only from cited TRUSTED facts (supplier text can never back a number).
    const allowed = new Set(citedFacts.filter((f) => f.trusted).flatMap((f) => numbersIn(f.text)));
    const bad = numbersIn(t).filter((x) => !allowed.has(x));
    if (bad.length) problems.push(`S${n}:NUMBER_NOT_IN_CITED_FACTS:${[...new Set(bad)].join(",")}`);
    if (URL_OR_EMAIL.test(t)) problems.push(`S${n}:URL_OR_EMAIL`);
    if (ACTION_CLAIMS.some((re) => re.test(t))) problems.push(`S${n}:ACTION_CLAIM`);
    const trustedCited = citedFacts.filter((f) => f.trusted);
    const tags = new Set(trustedCited.flatMap((f) => f.tags));
    const conditional = /\b(?:only (?:when|if|after)|unless|cannot|can't|can not|not|no|never|until|once)\b/i.test(t);
    // Fee responsibility / recipient wording is checked against the cited fee facts and removed only for the "paid" check.
    const feeFacts = trustedCited.filter((f) => f.tags.includes("FEE"));
    const forPaid = feeFacts.length > 0 ? withoutFeeRolePhrases(t, feeFacts) : null;
    const ruleCited = trustedCited.some((f) => f.tags.includes("RULE"));
    for (const w of STATE_WORDS) {
      if (w.label === "payable now" && conditional) continue;
      const subject = w.label === "paid" && forPaid !== null ? forPaid : t;
      if (!w.re.test(subject) || w.tags.some((tag) => tags.has(tag))) continue;
      if (w.label === "question state" && ruleCited && GENERAL_RULE_SENTENCE.test(t) && !NAMES_A_QUESTION.test(t) && !QUESTION_STATE.test(t.replace(RULE_PHRASE, " "))) continue;
      problems.push(`S${n}:STATE_WITHOUT_FACT:${w.label}`);
    }
    if (ALL_RESOLVED.test(t) && unresolvedInBundle && !NEGATED_RESOLVED.test(t)) problems.push(`S${n}:CLAIMS_ALL_RESOLVED`);
    sentences.push({ text: t.trim(), facts: ids });
  });
  if (ctx.intent === "WHY_NOT_APPROVABLE") {
    const dropped = ctx.facts.filter((f) => f.tags.includes("BLOCK") && !cited.has(f.id)).map((f) => f.id);
    if (dropped.length) problems.push(`BLOCKING_ITEM_NOT_EXPLAINED:${dropped.join(",")}`);
  }
  const uncited = ctx.facts.filter((f) => f.tags.includes("MUST_CITE") && !cited.has(f.id)).map((f) => f.id);
  if (uncited.length) problems.push(`REQUIRED_FACT_NOT_CITED:${uncited.join(",")}`);
  // A required fact with a `mention` must also be stated by a sentence that cites it (e.g. "confirm", "approv").
  for (const f of ctx.facts) {
    if (!f.tags.includes("MUST_CITE") || !f.mention || !cited.has(f.id)) continue;
    const re = new RegExp(f.mention, "i");
    if (!sentences.some((s) => s.facts.includes(f.id) && re.test(s.text))) problems.push(`REQUIRED_FACT_NOT_STATED:${f.id}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, sentences, nextStep: nextStep as string | null };
}
