"use client";

import { useEffect } from "react";
import { logGlobalError } from "@/lib/analytics/errors";

/**
 * A webpack/Next dynamic-import that 404s (its content-hashed chunk was rotated
 * out by a redeploy after this HTML was served) throws a `ChunkLoadError`. This
 * is the post-boot navigation race that survives the EdgeStack 60s HTML clamp:
 * a tab open across a deploy that then lazy-loads a now-missing chunk. We can
 * recover transparently with a single hard reload, which re-fetches fresh HTML
 * pointing at the current chunks. (It does NOT cover the *bootstrap* chunk
 * `main-app-*.js` 404 -- that fails before React mounts, so this component
 * never renders; the 60s edge clamp + the L2 S3-asset retention cover that.)
 */
function isChunkLoadError(error: Error): boolean {
  const name = error?.name ?? "";
  const message = error?.message ?? "";
  return (
    name === "ChunkLoadError" ||
    /Loading (CSS )?chunk [^\s]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message)
  );
}

/**
 * Root error boundary (#668 §1). This is the true last resort: it catches
 * errors thrown in the ROOT layout itself (or anything that escapes a segment
 * boundary) and **replaces `app/layout.tsx` entirely**, including `<html>` /
 * `<body>`. It therefore cannot use any app provider or the `(public)` chrome,
 * and must be fully self-contained.
 *
 * Branding is intentionally an INLINE TEXT wordmark with inline styles and no
 * external CSS / font / image dependency (settled in the SPEC): the cascade,
 * the Inter font, or the root layout may be exactly what failed, so this page
 * depends on nothing but the HTML it ships. `#B31B1B` is the public-site
 * Cornell-red token, hardcoded here because `globals.css` may not have loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logGlobalError({ digest: error.digest });

    // Self-heal a stale-chunk error with one hard reload. Throttled to at most
    // once per 10s via sessionStorage so a reload that immediately re-errors
    // (chunk genuinely gone) falls through to the manual recovery UI below
    // instead of looping, while a genuine chunk error later in the session can
    // still self-heal once. sessionStorage may be unavailable (private mode);
    // a failed read/write just skips the self-heal.
    if (!isChunkLoadError(error)) return;
    const KEY = "sps-chunk-reload-at";
    try {
      const last = Number(window.sessionStorage.getItem(KEY) ?? "0");
      if (Date.now() - last > 10_000) {
        window.sessionStorage.setItem(KEY, String(Date.now()));
        window.location.reload();
      }
    } catch {
      // sessionStorage blocked -> no self-heal; the UI below is the fallback.
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#ffffff",
          color: "#18181b",
        }}
      >
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "64px 24px", textAlign: "center" }}>
          <div style={{ marginBottom: 32 }}>
            <div
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontSize: 22,
                fontWeight: 600,
                color: "#B31B1B",
                lineHeight: 1,
              }}
            >
              Scholars
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "#6b7280",
                marginTop: 4,
              }}
            >
              Weill Cornell Medicine
            </div>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 600, margin: "0 0 12px" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#52525b", margin: "0 0 24px", lineHeight: 1.5 }}>
            We hit an unexpected error. This is usually temporary — please try again.
          </p>
          <div
            style={{ display: "flex", gap: 16, justifyContent: "center", alignItems: "center" }}
          >
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: "#B31B1B",
                color: "#ffffff",
                border: 0,
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* Hard navigation by design: reaching the root boundary means the
                app shell itself failed, so a full reload to "/" is the safe
                recovery — not a client soft-nav through a possibly-broken
                router. next/link is intentionally avoided here. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ color: "#B31B1B", textDecoration: "underline" }}>
              Return home
            </a>
          </div>
          {error.digest ? (
            <p style={{ color: "#a1a1aa", fontSize: 12, marginTop: 24 }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
