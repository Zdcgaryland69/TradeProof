"use client";

// "Create clarification draft" on the comparison page. One press = one request naming the run only; the
// server regenerates the comparison and returns the existing draft when the same basis already has one, so
// double clicks, refreshes or a second tab never create duplicates. Nothing is sent to anyone.

import { csrfHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en";

const t = en.clarification;

export default function CreateDraftButton({ requestId, seriesId, versionId, runId, baseRunId }: { requestId: string; seriesId: string; versionId: string; runId: string; baseRunId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/procurements/${requestId}/quotes/${seriesId}/versions/${versionId}/clarification-drafts`, {
        method: "POST",
        headers: { ...csrfHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ run: runId, baseRun: baseRunId }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { draftId?: string; message?: string } | null;
      if (res.ok && data?.draftId) {
        router.push(`/procurements/${requestId}/quotes/drafts/${data.draftId}`);
        return; // stay busy while navigating
      }
      setError(t.createFailed(data?.message ?? `HTTP ${res.status}`));
    } catch {
      setError(en.editor.outcomeUnknownKeepText);
    }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className="primary" disabled={busy} onClick={() => void create()} data-testid="create-draft">
        {busy ? t.creating : t.create}
      </button>
      {error ? (
        <p className="small error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
