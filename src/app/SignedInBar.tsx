"use client";

// Signed-in account and sign-out (30 Oct). Sign-out revokes the session on the server; afterwards the old cookie and
// any old link lead back to the sign-in page.

import { useState } from "react";
import { csrfHeaders } from "@/lib/csrf-client";

export function SignedInBar({ name, role }: { name: string; role: "BUYER" | "APPROVER" }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    // Panels holding answers for this account (Copilot) clear them before the request is sent.
    window.dispatchEvent(new Event("tradeproof:signing-out"));
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: csrfHeaders(), cache: "no-store" });
    } finally {
      // A full page load on purpose: no client state of the signed-out account survives.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }
  return (
    <div className="signed-in small" data-testid="signed-in" data-role={role}>
      Signed in as <strong data-testid="signed-in-name">{name}</strong> ({role === "BUYER" ? "buyer" : "approver"}) ·{" "}
      <button type="button" onClick={() => void signOut()} disabled={busy} data-testid="sign-out">
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
