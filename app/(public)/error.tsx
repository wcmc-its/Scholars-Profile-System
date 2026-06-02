"use client";

import { useEffect } from "react";
import { ErrorContent } from "@/components/site/error-content";
import { logErrorBoundary } from "@/lib/analytics/errors";

/**
 * Segment error boundary for the public route group (#668 §1). Catches errors
 * thrown by any Server/Client Component below it — e.g. an Aurora cold-cache
 * 5xx on a profile/topic/dept/center render. Renders inside `(public)/layout`,
 * so it inherits the `SiteHeader`/`SiteFooter` chrome automatically.
 *
 * `reset()` re-renders the segment — recovering from a transient blip without a
 * full reload. The underlying error is logged server-side by Next (with the
 * same `digest`); the `error_boundary` event here is the browser-RUM correlate.
 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logErrorBoundary({ digest: error.digest });
  }, [error]);

  return <ErrorContent onRetry={reset} reference={error.digest} />;
}
