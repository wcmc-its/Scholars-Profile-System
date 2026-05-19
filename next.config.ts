import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  // ADR-008: emit a standalone server bundle for the production container
  // image (see Dockerfile) — only traced dependencies are included.
  output: "standalone",
  // Pin the file-tracing root so the standalone bundle lands at a stable
  // path (.next/standalone/server.js). Without this, Next infers the root
  // from the nearest lockfile, which is ambiguous when the build runs from
  // a nested checkout.
  outputFileTracingRoot: process.cwd(),
  // Issue #391 — keep jsdom (pulled in by isomorphic-dompurify in
  // lib/edit/validators.ts) external to the server bundle. jsdom reads
  // browser/default-stylesheet.css via a module-relative path at runtime;
  // bundling drops that asset, so `next build` fails collecting page data
  // for the /api/edit/* routes.
  serverExternalPackages: ["isomorphic-dompurify", "jsdom"],
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // ADR-006: headshots render as a native <img> via the Radix Avatar
  // primitive, not next/image. `unoptimized` is a forward-guard — if a
  // <Image> component is ever added it will not route through the
  // request-time `/_next/image` sharp optimizer, which on the 1-vCPU
  // Fargate task would compete with Prisma for CPU (docs/PRODUCTION.md
  // § Database connection pooling).
  images: {
    unoptimized: true,
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
