// The English string catalogue (24 Oct): every entry is non-empty text, and the components that were
// moved to it no longer carry their own copies of the moved labels.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { en } from "../src/i18n/en.ts";

function walk(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim() === "") out.push(path);
  } else if (typeof value === "function") {
    const sample = (value as (...args: unknown[]) => unknown)("x", 1, 2, 3, 4);
    if (typeof sample !== "string" || sample.trim() === "") out.push(`${path}()`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
  }
}

test("every catalogue entry is non-empty text", () => {
  const empty: string[] = [];
  walk(en, "en", empty);
  assert.deepEqual(empty, []);
});

test("moved pages read their labels from the catalogue", () => {
  for (const [file, literal] of [
    ["src/app/procurements/[id]/ProcurementDetail.tsx", "Copy full ID"],
    ["src/app/procurements/[id]/ProcurementDetail.tsx", "Full ID:"],
    ["src/app/procurements/ProcurementEditor.tsx", "Edit conflict — nothing was overwritten"],
    ["src/app/procurements/page.tsx", "Local development only"],
  ]) {
    assert.ok(!readFileSync(file, "utf8").includes(literal), `${file} still contains "${literal}"`);
  }
});
