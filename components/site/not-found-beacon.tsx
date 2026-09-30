"use client";

import { useEffect } from "react";
import { VIVO_PATTERN } from "@/lib/analytics/vivo-pattern";

/** Which not-found site rendered: the root `app/not-found.tsx` (catches VIVO
 *  legacy URLs and unmatched paths) or the in-group `(public)/not-found.tsx`. */
export type NotFoundVariant = "root" | "public";

/** Derive the `not_found` pattern exactly as the old server-side not-found
 *  files did. Root: `vivo` for `/display/cwid-…`, else `other`. Public: a bare
 *  root slug (single segment) or legacy `/scholars/<slug>` is a profile miss,
 *  anything else (topics / centers / departments) is `other`. */
export function notFoundPattern(
  variant: NotFoundVariant,
  pathname: string,
): "vivo" | "profile" | "other" {
  if (variant === "root") return VIVO_PATTERN.test(pathname) ? "vivo" : "other";
  const segments = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  return pathname.startsWith("/scholars/") || segments.length === 1 ? "profile" : "other";
}

/**
 * 404 telemetry beacon. The not-found files used to read the path via
 * `await headers()`, but not-found renders on the server as part of every
 * route's tree, so that dynamic API forced every page under the layout to
 * render dynamically (defeating ISR on `/` and `/browse`). Reading the path
 * client-side keeps the not-found tree static and, unlike the old headers
 * (none of which were ever set), records the real path.
 *
 * Path only — `location.pathname` never includes the query string or hash
 * (privacy rule, docs/error-handling-spec.md §6). Renders nothing.
 */
export function NotFoundBeacon({ variant }: { variant: NotFoundVariant }) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const path = window.location.pathname;
    const payload = { event: "not_found", variant, path, pattern: notFoundPattern(variant, path) };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  }, [variant]);
  return null;
}
