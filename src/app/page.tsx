import Link from "next/link";

const steps = [
  {
    en: "Purchase request",
    zh: "采购需求",
    detail: "Buyer records item, spec, quantity, budget and delivery date.",
  },
  {
    en: "Bilingual quote understanding",
    zh: "双语报价理解",
    detail: "AI extracts fields from Chinese / English quotes and keeps the source text as evidence.",
  },
  {
    en: "Discrepancy check",
    zh: "差异检查",
    detail: "Spec, quantity, amount, currency, lead time and payment terms are compared against the request.",
  },
  {
    en: "Clarify with supplier",
    zh: "沟通确认",
    detail: "Open questions are collected and drafted as bilingual messages for a human to send.",
  },
  {
    en: "Human approval",
    zh: "人工审批",
    detail: "An approver reviews the evidence and explicitly approves or rejects.",
  },
  {
    en: "PayPal Sandbox payment",
    zh: "PayPal Sandbox 支付",
    detail: "Deterministic server code creates, captures and verifies the order. Sandbox only.",
  },
  {
    en: "Record archive",
    zh: "凭证归档",
    detail: "Request, quote, approval and payment IDs are linked into one traceable record.",
  },
];

export default function Home() {
  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">PayPal AI Hackathon · Prototype · Sandbox only</p>
        <h1>TradeProof</h1>
        <p className="tagline">
          Cross-border procurement review &amp; payment assistant
          <span className="zh">跨境采购审核与付款助手</span>
        </p>
      </header>

      <p className="cta">
        <Link className="button primary" href="/procurements">
          Procurement requests 采购需求 →
        </Link>{" "}
        <span className="small muted">Create and edit draft requests (local development only).</span>
      </p>

      <section aria-labelledby="flow-heading">
        <h2 id="flow-heading">Core flow 核心流程</h2>
        <ol className="flow">
          {steps.map((step, index) => (
            <li key={step.en} className="step">
              <span className="step-number">{index + 1}</span>
              <div>
                <h3>
                  {step.en} <span className="zh">{step.zh}</span>
                </h3>
                <p>{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="roles" aria-labelledby="roles-heading">
        <h2 id="roles-heading">Who does what</h2>
        <ul>
          <li>
            <strong>AI</strong> extracts, explains and drafts.
          </li>
          <li>
            <strong>People</strong> confirm and approve.
          </li>
          <li>
            <strong>Deterministic code</strong> validates and verifies payments.
          </li>
        </ul>
      </section>

      <footer className="status">
        Current status: procurement request drafts (local dev only) and a separate PayPal Sandbox payment check. Quote parsing, discrepancy check and approval are not implemented yet.
      </footer>
    </main>
  );
}
