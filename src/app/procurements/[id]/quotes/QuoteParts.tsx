// Small display pieces shared by the quote workspace and composer.

import { QUOTE_SOURCE_LABELS, type QuoteVersionSummary } from "@/lib/quote-versions";

export function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function SourcePill({ source }: { source: QuoteVersionSummary["source"] }) {
  const cls = source === "DEMO_SAMPLE" ? "pill source-demo" : source === "TEST_FIXTURE" ? "pill warn" : "pill";
  return <span className={cls}>{QUOTE_SOURCE_LABELS[source]}</span>;
}

/** Raw text with line numbers drawn by CSS (data attribute), so they are never part of the text or a copy of it. */
export function RawText({ text, label }: { text: string; label: string }) {
  const lines = text.split(/\r\n|\r|\n/);
  return (
    <div className="quote-text" role="region" aria-label={label}>
      {lines.map((line, i) => (
        // id: a stable target for "show this line" links (5 Nov decision summary); display only.
        <div className="ql" key={i} id={`quote-line-${i + 1}`}>
          <span className="ln" data-n={i + 1} aria-hidden="true" />
          <span className="lt">{line}</span>
        </div>
      ))}
    </div>
  );
}
