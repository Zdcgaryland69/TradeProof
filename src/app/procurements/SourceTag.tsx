// Data-source label for a procurement request. Driven only by the stored `source` field (never by the
// title). Display only: it does not grant or block anything.

import type { ProcurementSource } from "@/lib/procurement";

export function SourceTag({ source }: { source: ProcurementSource | null }) {
  if (source === "DEMO_SAMPLE") return <span className="pill source-demo">SYNTHETIC / DEMO</span>;
  if (source === "USER_INPUT") return <span className="pill">User input</span>;
  return (
    <span className="pill source-unknown" title="Created before the data source was recorded (22 Oct 2026); not inferred from the title.">
      Source not recorded
    </span>
  );
}
