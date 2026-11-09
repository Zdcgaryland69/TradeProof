"use client";

// Who may act on this request (30 Oct, docs/access-control.md). The owning buyer assigns or revokes the approver; the
// server checks ownership again on every change and writes an append-only grant row plus an audit row. A revoke takes
// effect on the approver's next request, and approvals that approver made here can no longer be used for payment —
// re-assigning does not bring them back.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { csrfHeaders } from "@/lib/csrf-client";

export interface ApproverRow {
  approverId: string;
  displayName: string;
  assigned: boolean;
  history: { seq: number; action: "GRANT" | "REVOKE"; createdAt: string }[];
}

export function AccessPanel({ requestId, ownerName, approvers, canManage, viewer }: { requestId: string; ownerName: string; approvers: ApproverRow[]; canManage: boolean; viewer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(approverId: string, action: "GRANT" | "REVOKE") {
    if (busy) return;
    setBusy(approverId);
    setError(null);
    try {
      const res = await fetch(`/api/procurements/${requestId}/approvers`, {
        method: "POST",
        headers: { ...csrfHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ approverId, action }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) setError(data?.message ?? `HTTP ${res.status}`);
    } catch {
      setError("We couldn't confirm the result. The change may have been saved. Reload the page to see the current access state before trying again.");
    }
    setBusy(null);
    router.refresh();
  }

  return (
    <section className="card anchor-target" id="access" aria-label="Access" data-testid="access-panel">
      <h2>Access</h2>
      <p className="small">
        Owner (buyer): <strong data-testid="owner-name">{ownerName}</strong> · You: {viewer}
      </p>
      {canManage ? (
        <>
          <p className="small muted">Only the approver you assign can approve this request. You cannot approve it yourself. Removing an approver stops further payment with approvals they made here; assigning them again does not restore those approvals.</p>
          {approvers.length === 0 ? <p className="small">No approver account exists yet.</p> : null}
          <ul className="plain approver-list">
            {/* 7 Nov: assigned approvers first, then the others (same rows, same buttons). */}
            {[...approvers.filter((a) => a.assigned), ...approvers.filter((a) => !a.assigned)].map((a) => (
              <li key={a.approverId} data-testid="approver-row" data-assigned={a.assigned ? "yes" : "no"}>
                <strong>{a.displayName}</strong> — {a.assigned ? "assigned" : "not assigned"}{" "}
                <button type="button" disabled={busy !== null} onClick={() => void change(a.approverId, a.assigned ? "REVOKE" : "GRANT")} data-testid={a.assigned ? "approver-revoke" : "approver-grant"}>
                  {busy === a.approverId ? "Saving…" : a.assigned ? "Remove approver" : "Assign as approver"}
                </button>
                {a.history.length > 0 ? (
                  <span className="small muted block">
                    History: {a.history.map((h) => `${h.action === "GRANT" ? "assigned" : "removed"} ${h.createdAt.slice(0, 16).replace("T", " ")} UTC`).join(" · ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="small muted" data-testid="approver-readonly">
          You are the assigned approver: you can read this request and approve or revoke on its Approval page. Editing, quotes, reviews, replies and payment belong to the buyer.
        </p>
      )}
      {error ? (
        <p className="small error" role="alert" data-testid="access-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * 7 Nov: compact access line at the top of the request page (server-rendered, read-only). The full panel with every
 * approver account sits after the request details, so a long account list never pushes the request, Edit or Save down.
 */
export function AccessSummary({ ownerName, assigned, viewer, role }: { ownerName: string; assigned: string[]; viewer: string; role: "OWNER" | "APPROVER" | "OTHER" }) {
  return (
    <section className="card access-summary" aria-label="Access summary" data-testid="access-summary" data-assigned={assigned.length}>
      <p className="small">
        <strong>Access</strong> · Owner (buyer): {ownerName} ·{" "}
        {role === "APPROVER" ? (
          <>Approver: you</>
        ) : assigned.length > 0 ? (
          <>
            Approver: <span data-testid="summary-approver">{assigned.join(", ")}</span>
          </>
        ) : (
          <span className="unsaved" data-testid="summary-no-approver">
            No approver assigned — nobody can approve yet
          </span>
        )}{" "}
        · You: {viewer}
        {role === "OWNER" ? (
          <>
            {" "}
            · <a href="#access">{assigned.length > 0 ? "Manage access" : "Assign an approver"} ↓</a>
          </>
        ) : null}
      </p>
      {role === "APPROVER" ? <p className="small muted">You can read this request and approve on its Approval page (Quotes → decision summary → Review and approve). Editing, quotes, reviews and payment belong to the buyer.</p> : null}
    </section>
  );
}
