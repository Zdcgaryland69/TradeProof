"use client";

// Payment of one approval (30 Oct). Every button posts ids only — never an amount, currency, payee or order to pay; the
// server reads those from the stored approval and re-checks its validity at each step. One step at a time: a second
// click while a step runs sends nothing, and nothing is retried automatically. After each step the page is re-rendered
// from the server, so what is shown is the stored state, not a guess.
//
// SANDBOX: PayPal JavaScript SDK v6 button (same integration as /sandbox-demo); MOCK (database copy only): a button that
// simulates the buyer's approval, no PayPal request.

import { csrfHeaders } from "@/lib/csrf-client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { en } from "@/i18n/en";
import { paymentKind, paymentLabels } from "@/lib/payment-labels";

const t = en.approval.pay;
const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core"; // Sandbox only

interface PayPalSession {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface PayPalSdkInstance {
  findEligibleMethods(): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: { onApprove: (data: { orderId: string }) => Promise<void>; onCancel: (data?: unknown) => void; onError: (error: unknown) => void }): PayPalSession | Promise<PayPalSession>;
}
type PayPalGlobal = { createInstance(options: { clientId: string; components: string[]; pageType?: string }): Promise<PayPalSdkInstance> };

let sdkScriptPromise: Promise<void> | null = null;
function loadSdkScript(): Promise<void> {
  if ((window as unknown as { paypal?: PayPalGlobal }).paypal) return Promise.resolve();
  sdkScriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkScriptPromise = null;
      reject(new Error("Could not load the PayPal Sandbox SDK"));
    };
    document.head.appendChild(script);
  });
  return sdkScriptPromise;
}

export interface PanelPayment {
  recordId: string;
  status: string;
  amount: string;
  paypalOrderId: string | null;
  paypalOrderStatus: string | null;
  paypalCaptureId: string | null;
  paypalCaptureStatus: string | null;
  lastError: string | null;
  sku: string;
}

export function PaymentPanel({
  requestId,
  approvalId,
  mode,
  clientId,
  canStart,
  active,
  current,
}: {
  requestId: string;
  approvalId: string;
  mode: "SANDBOX" | "MOCK";
  clientId: string | null;
  /** ACTIVE approval, no blocker, no current record. */
  canStart: boolean;
  /** The approval is still ACTIVE. Otherwise only the read-only check is offered (the server refuses the rest). */
  active: boolean;
  current: PanelPayment | null;
}) {
  const router = useRouter();
  const base = `/api/procurements/${requestId}/approvals/${approvalId}/payment`;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sdkMessage, setSdkMessage] = useState("");
  const buttonHost = useRef<HTMLDivElement>(null);

  // 9 Nov: wording by the current record's own kind (its sku); before a record exists, by this server's mode.
  const L = paymentLabels(current ? paymentKind(current.sku) : mode === "MOCK" ? "MOCK" : "SANDBOX");

  async function step(path: string, body: unknown = {}): Promise<{ ok: boolean; code?: string; message?: string; orderId?: string }> {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { ...csrfHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body), cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; message?: string; orderId?: string } | null;
    return { ok: res.ok && data?.ok !== false, code: data?.code ?? `HTTP_${res.status}`, message: data?.message ?? `HTTP ${res.status}`, orderId: data?.orderId };
  }

  async function run(path: string, body: unknown = {}) {
    if (busyRef.current) return; // one step at a time; a double click sends nothing
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const r = await step(path, body);
      setMessage({ kind: r.ok ? "ok" : "error", text: `${r.code}: ${r.message}` });
    } catch {
      setMessage({ kind: "error", text: `We couldn't confirm the result. The outcome of this payment step is unknown — use ${L.reconcile}; do not pay again.` });
    }
    busyRef.current = false;
    setBusy(false);
    router.refresh();
  }

  const status = current?.status ?? null;
  const orderStep = active && (status === "NEW" || status === "ORDER_CREATING");
  const awaitingBuyer = active && status === "ORDER_CREATED";
  const readable = status !== null && !["NEW", "FAILED"].includes(status);

  // SANDBOX: mount the PayPal button while the record can still be approved by the buyer.
  useEffect(() => {
    const host = buttonHost.current;
    if (mode !== "SANDBOX" || !host || !clientId || !(orderStep || awaitingBuyer)) return;
    let cancelled = false;
    (async () => {
      try {
        setSdkMessage(t.sdkLoading);
        await loadSdkScript();
        const paypal = (window as unknown as { paypal: PayPalGlobal }).paypal;
        const sdk = await paypal.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" });
        const eligibility = await sdk.findEligibleMethods();
        if (cancelled) return;
        if (!eligibility.isEligible("paypal")) {
          setSdkMessage("PayPal is not eligible for this browser / session.");
          return;
        }
        const session = await sdk.createPayPalOneTimePaymentSession({
          onApprove: async (data) => {
            await run("/capture", { orderId: data.orderId });
          },
          onCancel: () => {
            setMessage({ kind: "error", text: "PayPal window closed. Nothing is treated as paid or unpaid — use Check with PayPal (read-only)." });
            router.refresh();
          },
          onError: (error) => {
            setMessage({ kind: "error", text: `PayPal SDK error (${error instanceof Error ? error.message : "unknown"}). Outcome unknown — use Check with PayPal (read-only); do not pay again.` });
            router.refresh();
          },
        });
        const button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", async () => {
          if (busyRef.current) return;
          const order = step("/order").then((r) => {
            setMessage({ kind: r.ok ? "ok" : "error", text: `${r.code}: ${r.message}` });
            if (!r.ok || !r.orderId) throw new Error(r.message);
            return { orderId: r.orderId };
          });
          try {
            await session.start({ presentationMode: "auto" }, order);
          } catch (error) {
            setMessage({ kind: "error", text: `Checkout did not start: ${error instanceof Error ? error.message : "unknown error"}` });
            router.refresh();
          }
        });
        if (cancelled) return;
        host.replaceChildren(button);
        setSdkMessage("");
      } catch (error) {
        if (!cancelled) setSdkMessage(error instanceof Error ? error.message : "PayPal SDK failed to load");
      }
    })();
    return () => {
      cancelled = true;
      host.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-mount only when the record's status or the mode change
  }, [mode, clientId, status, active]);

  return (
    <div data-testid="payment-actions" data-mode={mode}>
      {current ? (
        <p className="small" data-testid="payment-status" data-status={current.status}>
          <span className={`pill s-${current.status}`}>{current.status}</span> {L.statusHelp(current.status)}
        </p>
      ) : null}
      <div className="actions">
        {canStart && !current ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void run("")} data-testid="pay-start">
            {busy ? t.working : t.start}
          </button>
        ) : null}
        {mode === "MOCK" && orderStep ? (
          <button type="button" disabled={busy} onClick={() => void run("/order")} data-testid="pay-order">
            {busy ? t.working : L.createOrder}
          </button>
        ) : null}
        {mode === "MOCK" && awaitingBuyer ? (
          <button type="button" disabled={busy} onClick={() => void run("/mock-approve")} data-testid="pay-mock-approve">
            {t.mockApprove}
          </button>
        ) : null}
        {awaitingBuyer ? (
          <button type="button" disabled={busy} onClick={() => void run("/capture", current?.paypalOrderId ? { orderId: current.paypalOrderId } : {})} data-testid="pay-capture">
            {busy ? t.working : t.capture}
          </button>
        ) : null}
        {readable ? (
          <button type="button" disabled={busy} onClick={() => void run("/reconcile")} data-testid="pay-reconcile">
            {L.reconcile}
          </button>
        ) : null}
      </div>
      {mode === "SANDBOX" && (orderStep || awaitingBuyer) ? (
        <div>
          <p className="small muted">{t.buyerHint}</p>
          <div ref={buttonHost} className="paypal-host" data-testid="paypal-host" />
          {sdkMessage ? <p className="small">{sdkMessage}</p> : null}
        </div>
      ) : null}
      {message ? (
        <p className={`small ${message.kind === "error" ? "error" : "ok"}`} role={message.kind === "error" ? "alert" : "status"} data-testid="pay-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
