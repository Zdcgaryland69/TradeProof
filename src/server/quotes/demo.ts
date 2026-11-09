// "Load demo" for quotes: reads the SYNTHETIC supplier quotes in samples/synthetic (only read, never
// changed) so the editor can be filled. Nothing is saved here; the user reviews and clicks Save.
// Line endings are given as LF: the files' CRLF/LF depends on the Git checkout, and a browser text box
// reports LF anyway, so LF is what would be saved from the editor. Text is otherwise unchanged.

import { readFileSync } from "node:fs";
import path from "node:path";

export interface QuoteDemoSample {
  key: "zh" | "en" | "revised";
  label: string;
  name: string;
  supplierDisplayName: string;
  sourceNote: string;
  supplierQuoteDate: string | null;
  text: string;
}

const SAMPLES: Omit<QuoteDemoSample, "text">[] = [
  {
    key: "zh",
    label: "Chinese quotation 中文报价单",
    name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118 (中文)",
    supplierDisplayName: "宁波示例日用品有限公司（虚构）",
    sourceNote: "samples/synthetic/supplier-quote-zh.synthetic.md",
    supplierQuoteDate: "2026-10-15",
  },
  {
    key: "en",
    label: "English summary email",
    name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118 (English summary)",
    supplierDisplayName: "Ningbo Example Housewares Co., Ltd. (fictional)",
    sourceNote: "samples/synthetic/supplier-quote-en.synthetic.md",
    supplierQuoteDate: null,
  },
  {
    // 3 Nov: a revised sample-order quote after the clarification (20 pcs, USD 68.00, 100 % before shipment) — the only
    // demo quote whose MOCK run can reach an approval and a MOCK payment (within the USD 100.00 Sandbox ceiling).
    key: "revised",
    label: "Revised sample-order quote 修订报价（样品单） · SYNTHETIC, MOCK demo",
    name: "[SYNTHETIC / DEMO] QT-DEMO-2026-118-R1 (样品单)",
    supplierDisplayName: "宁波示例日用品有限公司（虚构）",
    sourceNote: "samples/synthetic/supplier-quote-revised.synthetic.md",
    supplierQuoteDate: "2026-11-03",
  },
];

// Literal paths (not built from data) so the bundler traces only these files.
const READERS: Record<QuoteDemoSample["key"], (root: string) => string> = {
  zh: (root) => readFileSync(path.join(root, "samples", "synthetic", "supplier-quote-zh.synthetic.md"), "utf8"),
  en: (root) => readFileSync(path.join(root, "samples", "synthetic", "supplier-quote-en.synthetic.md"), "utf8"),
  revised: (root) => readFileSync(path.join(root, "samples", "synthetic", "supplier-quote-revised.synthetic.md"), "utf8"),
};

/** The samples, or only those whose file exists and carries the SYNTHETIC / DEMO banner. */
export function loadQuoteDemoSamples(root: string = process.cwd()): QuoteDemoSample[] {
  const out: QuoteDemoSample[] = [];
  for (const sample of SAMPLES) {
    try {
      const text = READERS[sample.key](root).replace(/\r\n/g, "\n");
      if (!text.startsWith("> SYNTHETIC / DEMO")) continue;
      out.push({ ...sample, text });
    } catch {
      // missing sample: the button for it is not offered
    }
  }
  return out;
}
