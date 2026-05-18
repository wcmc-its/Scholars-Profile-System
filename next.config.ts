import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // No server-side image optimization — see docs/ADR-006. The app uses
  // next/image nowhere; headshots render as plain <img> (Radix Avatar)
  // straight from directory.weill.cornell.edu. `unoptimized` is a guardrail:
  // if an <Image> is ever added it will not spin up sharp on the 1-vCPU
  // Fargate task.
  images: {
    unoptimized: true,
  },
  // Security headers on every response — issue #120 (B21). The CSP is
  // report-only; see lib/security-headers.ts. `serverActions.allowedOrigins`
  // is intentionally absent — the codebase uses no server actions.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders({
          isProduction: process.env.NODE_ENV === "production",
        }),
      },
    ];
  },
};

export default nextConfig;
