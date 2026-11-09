import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 9 Nov: hide the dev-only route indicator badge (it appeared in demo recordings). Compile and runtime errors are
  // still shown by Next.js; no effect on production builds or on any server-side check.
  devIndicators: false,
};

export default nextConfig;
