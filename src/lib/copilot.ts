// TradeProof Copilot v1 (2 Nov 2026; plan docs/copilot-plan.md). Pure TypeScript shared by the server and the panel.
//
// Five fixed questions about ONE procurement record; no free text. The server answers in two layers:
//   1. facts — computed by TradeProof's own deterministic code from stored records (never by a model);
//   2. an optional explanation — a model (or the labelled MOCK) re-states those facts in plain English, citing fact
//      ids. It is shown only if it passes the validator; it can never change an amount, a gate status, an approval's
//      validity or a payment status, and it can never act (approve, pay, send, save).
// Answers are not stored. A citation that exists does not prove the explanation is right; a person checks it.

export const COPILOT_INTENTS = ["DIFFERENCES", "WHY_NOT_APPROVABLE", "AFTER_REPLY", "PAYMENT_AMOUNT", "NEXT_STEP"] as const;
export type CopilotIntent = (typeof COPILOT_INTENTS)[number];

export const COPILOT_QUESTIONS: Record<CopilotIntent, string> = {
  DIFFERENCES: "What differs between the quote and my request?",
  WHY_NOT_APPROVABLE: "Why can't this be approved?",
  AFTER_REPLY: "What is still open after the supplier's reply?",
  PAYMENT_AMOUNT: "How much is this payment, and which costs are unknown or excluded?",
  NEXT_STEP: "Where do I go next?",
};

/** Owner-agreed limits (2 Nov). Characters are NOT a token or cost limit; the cost bound comes from the ledger rules. */
export const COPILOT_LIMITS = {
  /** The content package sent to a model (facts + supplier text + links). Larger → refused, never cut. */
  maxBundleChars: 12_000,
  maxOutputTokens: 1_000,
  timeoutMs: 60_000,
  /** One attempt per ask: no SDK retry, no application retry, no re-ask after invalid or truncated output. */
  maxAttempts: 1,
  maxSentences: 12,
  maxSentenceChars: 400,
  maxCitationsPerSentence: 8,
  /** Upper bound of ONE ask's reservation (US$0.04 in micro-units). A larger bound → nothing reserved or sent. */
  maxReservedMicros: 40_000,
} as const;

export type FactTag =
  | "REQUEST"
  | "QUOTE"
  | "RUN"
  | "ROLE"
  | "GATE"
  | "GATE_BLOCKED"
  | "GATE_READY"
  | "BLOCK"
  | "CONFIRM"
  | "DIFFERENCE"
  | "APPROVAL"
  | "APPROVAL_ACTIVE"
  | "PAYMENT"
  | "PAID"
  | "AMOUNT"
  | "FEE"
  | "QUESTION"
  | "Q_UNRESOLVED"
  | "DRAFT"
  | "REPLY"
  | "NOT_AVAILABLE"
  | "NEXT_STEP"
  | "SUPPLIER_TEXT"
  /** Must be cited by a passing explanation (difference rows, unresolved questions; BLOCKs for WHY_NOT_APPROVABLE). */
  | "MUST_CITE"
  /** Never emitted in v1: no fact supports an unconditional "you can pay now" (role, switch and payment state also decide). */
  | "PAYABLE_NOW"
  /** A fixed TradeProof rule (system boundary), stated by the server — never derived from a record or a model. */
  | "RULE";

export interface CopilotFact {
  /** F1…Fn, assigned per answer by the server. */
  id: string;
  /** Plain English, built by TradeProof from stored records (supplier text is quoted verbatim, original language). */
  text: string;
  /** false = supplier text (quote or reply): data only, never instructions; its numbers can never back a sentence. */
  trusted: boolean;
  tags: FactTag[];
  /** Stored ids this fact comes from (request, version, run, review, approval, draft, reply …). */
  source: Record<string, string | number | null>;
  /** Stable meaning of the fact across rule versions (e.g. GATE, AMOUNT_THIS, FEE:THIS_VERSION:1, Q2) — for evidence replay. */
  key?: string;
  /**
   * MUST_CITE facts only: a regular expression (case-insensitive) that at least one sentence citing this fact must match,
   * so the point is actually stated, not just cited (e.g. "confirm" for a READY WITH CONFIRMATIONS check).
   */
  mention?: string;
}

export interface CopilotLink {
  /** L1…Ln. The model may only name one of these ids; the URL is built by the server. */
  id: string;
  label: string;
  href: string;
}

export type ExplanationReason =
  | "NO_MODEL"
  | "LIVE_NOT_AUTHORISED"
  | "BUDGET_NOT_CONFIGURED"
  | "BUDGET_REFUSED"
  | "BUNDLE_TOO_LARGE"
  | "TOKEN_COUNT_FAILED"
  | "TIMEOUT"
  | "MODEL_ERROR"
  | "REFUSED"
  | "OUTPUT_TRUNCATED"
  | "FAILED_CHECK"
  | "ALREADY_ASKED";

export type CopilotExplanation =
  | { kind: "LIVE" | "MOCK"; provider: string; model: string; sentences: { text: string; facts: string[] }[]; nextStep: string | null }
  | { kind: "NONE"; reason: ExplanationReason; detail: string | null };

/** Parts of the basis, each hashed: the panel compares them to say what changed. */
export const BASIS_PARTS = ["request", "quote", "run", "reviews", "statements", "classifications", "approvals", "drafts", "replies", "payments"] as const;
export type BasisPart = (typeof BASIS_PARTS)[number];

export interface CopilotBasis {
  digest: string;
  parts: Record<BasisPart, string>;
}

export interface AnswerFor {
  /** Opaque hash of the account: the panel drops answers for another account; never the account id itself. */
  account: string;
  requestId: string;
  seriesId: string | null;
  versionId: string | null;
  runId: string | null;
  intent: CopilotIntent;
  nonce: string;
}

export interface CopilotAnswer {
  intent: CopilotIntent;
  question: string;
  facts: CopilotFact[];
  links: CopilotLink[];
  /** Deterministic next step (NEXT_STEP rules), a link id or null. */
  nextStep: { text: string; link: string | null } | null;
  /** Fixed TradeProof rules shown with this answer (server text, not AI), e.g. "answered ≠ approved". */
  notices: string[];
  explanation: CopilotExplanation;
  /** Basis the explanation was made on, and whether it still equals the basis recomputed after the call. */
  basis: CopilotBasis;
  status: "CURRENT" | "OUTDATED";
  changed: BasisPart[];
  /** True when this is the repeat of an ask already answered (same request key): no second model call was made. */
  repeat: boolean;
  answerFor: AnswerFor;
}

/**
 * System boundary (owner, 2 Nov late night): recording a supplier's answer to a question never approves a term. Shown by
 * the server with every "What is still open…" answer and given to the model as a citable rule fact.
 */
export const RULE_ANSWERED_NOT_APPROVED = "TradeProof rule: a question marked answered records the supplier's reply; it does not approve any term. Only the assigned approver approves, on the approval page.";

export const COPILOT_NONCE = /^[A-Za-z0-9-]{8,64}$/;

/** Which parts differ between two bases (empty = same basis). */
export function changedParts(a: CopilotBasis, b: CopilotBasis): BasisPart[] {
  return BASIS_PARTS.filter((p) => a.parts[p] !== b.parts[p]);
}

export const BASIS_PART_LABELS: Record<BasisPart, string> = {
  request: "request changed",
  quote: "a newer quote version was saved",
  run: "the extraction run changed",
  reviews: "reviews changed",
  statements: "buyer statements changed",
  classifications: "requirement classifications changed",
  approvals: "approvals changed",
  drafts: "a clarification draft changed",
  replies: "supplier replies or answers changed",
  payments: "a payment changed",
};

export const EXPLANATION_REASON_LABELS: Record<ExplanationReason, string> = {
  NO_MODEL: "No AI model is configured on this server, so nothing was sent.",
  LIVE_NOT_AUTHORISED: "Real AI explanations are not switched on for this server (owner authorisation needed), so nothing was sent.",
  BUDGET_NOT_CONFIGURED: "The AI budget is not configured, so nothing was sent.",
  BUDGET_REFUSED: "The shared AI budget does not allow this call now, so nothing was sent.",
  BUNDLE_TOO_LARGE: "This record's facts and texts are larger than the Copilot may send (12,000 characters). Nothing was cut and nothing was sent; the facts above are complete.",
  TOKEN_COUNT_FAILED: "The size of the request could not be counted, so no budget was reserved and nothing was sent.",
  TIMEOUT: "No reply within 60 s. The provider may still have processed it; its reserved cost stays counted. It is not sent again.",
  MODEL_ERROR: "The model call failed. It may have been processed; its reserved cost stays counted. It is not sent again.",
  REFUSED: "The model declined this request. Nothing from it is shown.",
  OUTPUT_TRUNCATED: "The reply hit the output limit and is incomplete; nothing from it is shown. It is not sent again.",
  FAILED_CHECK: "The explanation did not pass TradeProof's checks (citations, numbers, states, no actions), so it is not shown.",
  ALREADY_ASKED: "This click was already sent once; it is not sent again. Ask again with a new click.",
};
