import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "directory.weill.cornell.edu",
        pathname: "/**",
      },
    ],
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
