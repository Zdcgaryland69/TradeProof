"use client";

// Copies a FULL database id (pr_… / pri_…). The short reference next to it is display only.

import { useState } from "react";
import { en } from "@/i18n/en";

export function CopyId({ id, label, done, className = "" }: { id: string; label: string; done: string; className?: string }) {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard not available");
      await navigator.clipboard.writeText(id);
      setState({ ok: true, text: done });
    } catch {
      setState({ ok: false, text: en.common.copyFailed });
    }
  }
  return (
    <>
      <button type="button" className={className} onClick={copy} data-copy-id={id}>
        {label}
      </button>
      {state ? (
        <span className={state.ok ? "copy-ok" : "error"} role="status">
          {state.text}
        </span>
      ) : null}
    </>
  );
}

/** "IT-1A2B3C4D" with the full id selectable and a copy button. */
export function ItemRef({ id, refText }: { id: string; refText: string }) {
  return (
    <span className="item-ref small">
      <span className="muted">{en.ids.itemReference}</span> <strong className="ref" title={id}>{refText}</strong>{" "}
      <CopyId id={id} label={en.common.copy} done={en.ids.itemIdCopied(refText)} className="link-button neutral" />
    </span>
  );
}
