import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TradeProof — Cross-border procurement review & payment assistant",
  description:
    "TradeProof helps buyers review bilingual supplier quotes, confirm open questions, get human approval, and pay through PayPal Sandbox with a traceable record.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
