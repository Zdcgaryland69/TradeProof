"use client";

// Sign-in form (30 Oct). Sends username + password once to the server, which sets the HttpOnly session cookie.
// Nothing is stored in localStorage; the password field is cleared after every attempt.

import { useState } from "react";

export function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }), cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setPassword("");
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      setError(data?.message ?? `HTTP ${res.status}`);
    } catch {
      setPassword("");
      setError("The server could not be reached.");
    }
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)} data-testid="login-form">
      <label className="block">
        Username
        <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} data-field="username" required />
      </label>
      <label className="block">
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-field="password" required />
      </label>
      <button type="submit" className="primary" disabled={busy} data-testid="login-submit">
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error ? (
        <p className="small error" role="alert" data-testid="login-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
