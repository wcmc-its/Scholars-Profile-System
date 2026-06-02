"use client";

import { useEffect } from "react";
import { ErrorContent } from "@/components/site/error-content";
import { logErrorBoundary } from "@/lib/analytics/errors";

/**
 * Search segment error boundary (#668 §3). The OpenSearch backend is a live
 * request-path dependency scoped to `/search` (see dependency-outage-matrix);
 * an outage throws from the page's search calls (the shell badge-counts and/or
 * the streamed `<Suspense>` results). Without this boundary that throw reaches
 * the unstyled Next.js 500. Here it renders a branded "temporarily
 * unavailable" panel inside the `(public)` chrome, with a retry and links to
 * browse — the rest of the site (served by Aurora) is unaffected.
 *
 * The boundary location reliably implies the failure domain, so we log
 * `kind: "search"`. The page also logs a server-side `search_degraded` event
 * at the data fetch (the authoritative server signal); this is the RUM correlate.
 */
export default function SearchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logErrorBoundary({ digest: error.digest, route: "/search", kind: "search" });
  }, [error]);

  return (
    <ErrorContent
      title="Search is temporarily unavailable"
      message="We couldn't reach the search service just now. This is usually brief — please try again. You can still browse scholars from the links below."
      onRetry={reset}
      reference={error.digest}
    />
  );
}
