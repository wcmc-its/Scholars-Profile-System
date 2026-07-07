import path from "node:path";
import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./lib/security-headers";

// Next.js 15.5 instrumentation bundle does not resolve the `node:` URI scheme
// for built-in modules pulled in from instrumentation.ts -> lib/tracing/init.ts
// -> lib/tracing/redact.ts ("import { createHash } from 'node:crypto'") --
// build fails with UnhandledSchemeError. The bare-name form ("crypto") then
// fails with "Module not found" because the instrumentation bundle treats
// built-ins as missing npm packages rather than Node-native modules.
//
// Fix: register the affected Node built-ins as commonjs externals for the
// server-side webpack bundles. Narrowly scoped to built-ins actually imported
// via the `node:` prefix anywhere in the server bundle graph (currently:
// crypto, fs/promises, path -- grep `node:` under `lib/`, `app/`, `prisma/`,
// `instrumentation.ts`). Add new entries here if a future module imports a
// new `node:*` built-in.
const NODE_BUILTIN_EXTERNALS: Record<string, string> = {
  "node:crypto": "commonjs crypto",
  "node:fs/promises": "commonjs fs/promises",
  "node:path": "commonjs path",
};

const nextConfig: NextConfig = {
  // ADR-008: emit a standalone server bundle for the production container
  // image (see Dockerfile) — only traced dependencies are included.
  output: "standalone",
  // Pin the file-tracing root so the standalone bundle lands at a stable
  // path (.next/standalone/server.js). Without this, Next infers the root
  // from the nearest lockfile, which is ambiguous when the build runs from
  // a nested checkout.
  outputFileTracingRoot: process.cwd(),
  // #1503 — shared S3-backed ISR cacheHandler so all app tasks read/write one
  // store and `revalidatePath` propagates across tasks (prod runs 2–6 tasks).
  // Gated OFF by default: without the flag Next uses its built-in in-process
  // handler, byte-identical to today. The flag is a STATIC literal read
  // (flag-parity gate); the flag + `NEXT_ISR_CACHE_BUCKET` are wired per-env in
  // cdk/lib/app-stack.ts. Absolute path: Next relativizes it to distDir and
  // traces the file (+ its @aws-sdk/client-s3 dep) into the standalone bundle
  // (build/collect-build-traces.ts), so the runtime container can load it.
  // `cacheMaxMemorySize: 0` disables Next's own LRU — the handler keeps its own
  // bounded per-task front cache. See docs/1503-shared-cachehandler-spec.md.
  ...(process.env.NEXT_ISR_CACHE_S3 === "on"
    ? {
        cacheHandler: path.join(
          process.cwd(),
          "lib/cache/isr-s3-cache-handler.js",
        ),
        cacheMaxMemorySize: 0,
      }
    : {}),
  // The CV (WCM format) generator reads the official WCM template `.docx` at
  // runtime via a cwd-relative path (lib/edit/cv-template.ts). Next can't trace
  // a dynamic readFile, so force the asset into the standalone bundle or the
  // /api/edit/cv route 500s in production (the file is absent under .next/standalone).
  outputFileTracingIncludes: {
    "/api/edit/cv": ["./lib/edit/assets/wcm-cv-template.docx"],
  },
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
  // Static security headers on every response — issue #120 (B21). These values
  // never change, so build-time evaluation in the routes manifest is correct.
  // The env-gated Content-Security-Policy is deliberately NOT here: `headers()`
  // is frozen at `next build`, so `SECURITY_CSP_MODE` could never be flipped on
  // a deployed image from it (#374). The CSP is emitted at runtime from
  // `middleware.ts` instead. See lib/security-headers.ts. `serverActions.
  // allowedOrigins` is intentionally absent — the codebase uses no server
  // actions.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders(),
      },
    ];
  },
  // Retired /about/* sub-pages folded into the single /about documentation
  // page (#573 follow-up). `/about/help` was removed in #573 and `/about/
  // methodology` is now a redirect stub (app/(public)/about/methodology); this
  // 308s `/about/help` so stale links land on /about rather than 404.
  async redirects() {
    return [{ source: "/about/help", destination: "/about", permanent: true }];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) return config;
    const externals = config.externals;
    if (Array.isArray(externals)) {
      externals.push(NODE_BUILTIN_EXTERNALS);
    } else if (externals !== undefined) {
      config.externals = [externals, NODE_BUILTIN_EXTERNALS];
    } else {
      config.externals = [NODE_BUILTIN_EXTERNALS];
    }
    return config;
  },
};

export default nextConfig;
