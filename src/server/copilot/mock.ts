// MOCK explanation (2 Nov). Not an AI: it re-states the trusted facts of the bundle verbatim, one sentence per fact,
// citing that fact (and the role fact), in the JSON shape a model must return — so the validator, the panel and the
// tests exercise the same path as a real model without any call. Always labelled "MOCK — canned test output, not AI".

import { COPILOT_LIMITS, type CopilotFact, type CopilotIntent, type CopilotLink, type FactTag } from "../../lib/copilot.ts";

export const COPILOT_MOCK = { provider: "mock", model: "copilot-restate-facts-v1" } as const;

const FIRST: Record<CopilotIntent, FactTag[]> = {
  DIFFERENCES: ["MUST_CITE", "DIFFERENCE", "NOT_AVAILABLE"],
  WHY_NOT_APPROVABLE: ["MUST_CITE", "BLOCK", "GATE", "APPROVAL", "NOT_AVAILABLE"],
  AFTER_REPLY: ["MUST_CITE", "QUESTION", "DRAFT", "NOT_AVAILABLE"],
  PAYMENT_AMOUNT: ["MUST_CITE", "AMOUNT", "FEE", "PAYMENT", "NOT_AVAILABLE"],
  NEXT_STEP: ["MUST_CITE", "NEXT_STEP", "GATE", "NOT_AVAILABLE"],
};

export function mockExplanation(intent: CopilotIntent, facts: CopilotFact[], links: CopilotLink[], nextStepLink: string | null): string {
  const role = facts.find((f) => f.tags.includes("ROLE"));
  const rank = (f: CopilotFact) => {
    const i = FIRST[intent].findIndex((t) => f.tags.includes(t));
    return i < 0 ? FIRST[intent].length : i;
  };
  const pick = facts
    .filter((f) => f.trusted && !f.tags.includes("REQUEST") && !f.tags.includes("RULE") && f !== role)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .slice(0, COPILOT_LIMITS.maxSentences)
    .map(({ f }) => f);
  const sentences = pick.map((f) => ({
    text: [...f.text].slice(0, COPILOT_LIMITS.maxSentenceChars - 1).join(""),
    facts: role ? [f.id, role.id] : [f.id],
  }));
  return JSON.stringify({ sentences, nextStep: nextStepLink && links.some((l) => l.id === nextStepLink) ? nextStepLink : null });
}
