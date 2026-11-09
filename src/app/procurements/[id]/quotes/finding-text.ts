// Wording of approval findings (moved here on 5 Nov from the approval page so the Quotes-page decision summary uses the
// exact same sentences). Text only: the findings themselves come from the server's evaluation.

import { en } from "@/i18n/en";

const t = en.approval;

export function findingText(f: { code: string; args: Record<string, string> }): string {
  const own = t.findings[f.code];
  if (own) return own(f.args);
  const m = /^(.*)_(NOT_REVIEWED|NOT_STATED)$/.exec(f.code);
  if (m) {
    const field = `${t.fieldNames[m[1]] ?? m[1]}${f.args.item ? ` — “${f.args.item}”` : f.args.fee ? ` — “${f.args.fee}”` : ""}`;
    return m[2] === "NOT_STATED" ? t.notStated(field) : t.notReviewed(field);
  }
  return f.code;
}

export const pathFor = (f: { code: string }): string | null => t.paths[f.code] ?? (/_NOT_(REVIEWED|STATED)$/.test(f.code) ? t.reviewPath : null);
