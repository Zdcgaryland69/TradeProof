"use client";

// Browser side of the Sandbox demo. Uses PayPal JavaScript SDK v6 (web-sdk/v6/core, clientId init,
// createPayPalOneTimePaymentSession) as in developer.paypal.com/checkout/integrate — no v5 APIs.
// The browser never sends amounts and never chooses which PayPal order is captured; the server
// decides both from the local record. Button disabling here is cosmetic; the server enforces.

import { useCallback, useEffect, useRef, useState } from "react";

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core"; // Sandbox only

interface RecordView {
  id: string;
  itemName: string;
  amount: string;
  status: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paypalOrderStatus: string | null;
  paypalCaptureStatus: string | null;
  createRequestId: string;
  captureRequestId: string | null;
  lastError: string | null;
  reviewReasons: string[];
  createdAt: string;
  paidAt: string | null;
}

interface ApiResult {
  ok: boolean;
  code: string;
  message: string;
  orderId?: string;
  problems?: string[];
  record?: RecordView | null;
}

interface Props {
  config: { configured: boolean; clientId: string | null; missing: string[]; errors: string[] };
  item: { sku: string; name: string; amount: string };
  initialRecords: RecordView[];
}

// Minimal typings for the parts of the v6 SDK used here.
interface PayPalSession {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface PayPalSdkInstance {
  findEligibleMethods(): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove: (data: { orderId: string }) => Promise<void>;
    onCancel: (data?: unknown) => void;
    onError: (error: unknown) => void;
  }): PayPalSession | Promise<PayPalSession>;
}
declare global {
  interface Window {
    paypal?: { createInstance(options: { clientId: string; components: string[]; pageType?: string }): Promise<PayPalSdkInstance> };
  }
}

const PAYABLE = new Set(["NEW", "ORDER_CREATING", "ORDER_CREATED"]);

const STATUS_HELP: Record<string, string> = {
  NEW: "Local record only — no PayPal order yet",
  ORDER_CREATING: "Creating PayPal order (or outcome unknown — retry reuses the same request id)",
  ORDER_CREATED: "PayPal order created — waiting for buyer approval",
  CAPTURING: "Capturing…",
  CAPTURE_UNKNOWN: "Capture outcome unknown — press Reconcile; do NOT pay again",
  CAPTURE_PENDING: "PayPal reports capture PENDING — not paid yet",
  PAID: "PAID — captured and verified against PayPal",
  NEEDS_REVIEW: "PayPal data did not match — not paid, needs human review",
  FAILED: "PayPal rejected the operation",
};

let sdkScriptPromise: Promise<void> | null = null;
function loadSdkScript(): Promise<void> {
  if (window.paypal) return Promise.resolve();
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

async function callApi(path: string, method: "GET" | "POST", body?: unknown): Promise<ApiResult> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as ApiResult | null;
  return data ?? { ok: false, code: `HTTP_${response.status}`, message: "Unexpected response" };
}

export default function SandboxDemo({ config, item, initialRecords }: Props) {
  const [records, setRecords] = useState<RecordView[]>(initialRecords);
  const [selectedId, setSelectedId] = useState<string | null>(initialRecords[0]?.id ?? null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sdkMessage, setSdkMessage] = useState<string>("");
  const buttonHost = useRef<HTMLDivElement>(null);

  const selected = records.find((r) => r.id === selectedId) ?? null;

  const note = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 30));
  }, []);

  const upsert = useCallback((record: RecordView | null | undefined) => {
    if (!record) return;
    setRecords((prev) => [record, ...prev.filter((r) => r.id !== record.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  const report = useCallback(
    (label: string, result: ApiResult) => {
      upsert(result.record);
      const problems = result.problems?.length ? ` — ${result.problems.join("; ")}` : "";
      note(`${label}: ${result.code} — ${result.message}${problems}`);
    },
    [note, upsert],
  );

  async function createRecord() {
    setBusy(true);
    try {
      const result = await callApi("/api/sandbox-demo/records", "POST", {});
      report("New test record", result);
      if (result.record) setSelectedId(result.record.id);
    } finally {
      setBusy(false);
    }
  }

  async function refresh(id: string) {
    const result = await callApi(`/api/sandbox-demo/records/${id}`, "GET");
    upsert(result.record);
    note(`Refreshed ${id.slice(0, 11)}…: ${result.record?.status ?? result.code}`);
  }

  async function reconcile(id: string) {
    setBusy(true);
    try {
      report("Reconcile", await callApi(`/api/sandbox-demo/records/${id}/reconcile`, "POST", {}));
    } finally {
      setBusy(false);
    }
  }

  // Mount the PayPal button for the selected record while it is still payable.
  const selectedStatus = selected?.status;
  useEffect(() => {
    const host = buttonHost.current;
    if (!host || !config.configured || !config.clientId || !selectedId || !selectedStatus || !PAYABLE.has(selectedStatus)) {
      return;
    }
    let cancelled = false;
    const recordId = selectedId;
    const clientId = config.clientId;

    (async () => {
      try {
        setSdkMessage("Loading PayPal Sandbox SDK…");
        await loadSdkScript();
        const sdk = await window.paypal!.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" });
        const eligibility = await sdk.findEligibleMethods();
        if (cancelled) return;
        if (!eligibility.isEligible("paypal")) {
          setSdkMessage("PayPal is not eligible for this browser/session.");
          return;
        }
        const session = await sdk.createPayPalOneTimePaymentSession({
          onApprove: async (data) => {
            note(`Buyer approved order ${data.orderId}; asking server to capture…`);
            report("Capture", await callApi(`/api/sandbox-demo/records/${recordId}/capture`, "POST", { orderId: data.orderId }));
          },
          onCancel: () => {
            note("PayPal window closed / cancelled. Record is NOT treated as unpaid or paid — press Reconcile to check with PayPal.");
            void refresh(recordId);
          },
          onError: (error) => {
            note(`PayPal SDK error (${error instanceof Error ? error.message : "unknown"}). Outcome unknown — press Reconcile; do not pay again.`);
            void refresh(recordId);
          },
        });
        const button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", async () => {
          const createOrder = callApi(`/api/sandbox-demo/records/${recordId}/order`, "POST", {}).then((result) => {
            report("Create PayPal order", result);
            if (!result.ok || !result.orderId) throw new Error(result.message);
            return { orderId: result.orderId };
          });
          try {
            await session.start({ presentationMode: "auto" }, createOrder);
          } catch (error) {
            note(`Checkout did not start: ${error instanceof Error ? error.message : "unknown error"}`);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-mount only when record/status/config change
  }, [selectedId, selectedStatus, config.configured, config.clientId]);

  return (
    <div className="demo">
      <section className="card" aria-labelledby="item-heading">
        <h2 id="item-heading">Test item 测试商品</h2>
        <p>
          <strong>{item.name}</strong> <span className="muted">({item.sku})</span>
        </p>
        <p className="amount">{item.amount}</p>
        <p className="muted small">Amount and currency are fixed on the server. 金额与币种由服务端固定，浏览器无法修改。</p>
      </section>

      <section className="card" aria-labelledby="config-heading">
        <h2 id="config-heading">PayPal Sandbox configuration</h2>
        {config.configured ? (
          <p>
            <span className="pill ok">Configured</span> Sandbox client ID loaded from <code>.env.local</code>. Secret stays on the server.
          </p>
        ) : (
          <div>
            <p>
              <span className="pill warn">未配置 Not configured</span> No payment can be made. Nothing here will show a fake success.
            </p>
            {config.missing.length > 0 && <p className="small">Missing in .env.local: {config.missing.join(", ")}</p>}
            {config.errors.map((e) => (
              <p className="small" key={e}>
                {e}
              </p>
            ))}
            <p className="small muted">See docs/sandbox-payment-plan.md §6, then restart the dev server.</p>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="records-heading">
        <h2 id="records-heading">Test records 测试记录</h2>
        <button type="button" onClick={createRecord} disabled={busy}>
          New test record (USD 1.00)
        </button>
        {records.length === 0 ? (
          <p className="muted">No records yet.</p>
        ) : (
          <ul className="records">
            {records.map((r) => (
              <li key={r.id}>
                <label>
                  <input type="radio" name="record" checked={r.id === selectedId} onChange={() => setSelectedId(r.id)} />
                  <code>{r.id.slice(0, 11)}…</code> <span className={`pill s-${r.status}`}>{r.status}</span>{" "}
                  <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section className="card" aria-labelledby="payment-heading">
          <h2 id="payment-heading">Payment status 付款状态</h2>
          <p>
            <span className={`pill s-${selected.status}`}>{selected.status}</span> {STATUS_HELP[selected.status] ?? ""}
          </p>
          <dl className="facts">
            <dt>Local record</dt>
            <dd>
              <code>{selected.id}</code>
            </dd>
            <dt>Amount</dt>
            <dd>{selected.amount}</dd>
            <dt>PayPal order</dt>
            <dd>
              <code>{selected.paypalOrderId ?? "—"}</code> {selected.paypalOrderStatus && <span className="muted">({selected.paypalOrderStatus})</span>}
            </dd>
            <dt>PayPal capture</dt>
            <dd>
              <code>{selected.paypalCaptureId ?? "—"}</code> {selected.paypalCaptureStatus && <span className="muted">({selected.paypalCaptureStatus})</span>}
            </dd>
            <dt>Request ids</dt>
            <dd className="small">
              create <code>{selected.createRequestId}</code>
              <br />
              capture <code>{selected.captureRequestId ?? "—"}</code>
            </dd>
            {selected.paidAt && (
              <>
                <dt>Verified paid at</dt>
                <dd>{new Date(selected.paidAt).toLocaleString()}</dd>
              </>
            )}
            {selected.reviewReasons.length > 0 && (
              <>
                <dt>Review reasons</dt>
                <dd>{selected.reviewReasons.join("; ")}</dd>
              </>
            )}
            {selected.lastError && (
              <>
                <dt>Last error</dt>
                <dd className="small">{selected.lastError}</dd>
              </>
            )}
          </dl>

          {config.configured && PAYABLE.has(selected.status) && (
            <div>
              <p className="small muted">
                Log in with your <strong>Sandbox Personal (buyer)</strong> account in the PayPal window.
              </p>
              <div ref={buttonHost} className="paypal-host" />
              {sdkMessage && <p className="small">{sdkMessage}</p>}
            </div>
          )}

          <div className="actions">
            <button type="button" onClick={() => refresh(selected.id)} disabled={busy}>
              Refresh
            </button>
            <button type="button" onClick={() => reconcile(selected.id)} disabled={busy || !config.configured}>
              Reconcile with PayPal 查询核实
            </button>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="log-heading">
        <h2 id="log-heading">Activity</h2>
        {log.length === 0 ? <p className="muted small">Nothing yet.</p> : <pre className="log">{log.join("\n")}</pre>}
      </section>
    </div>
  );
}
