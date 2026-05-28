"use client";

/**
 * Site-wide feedback badge (#538, docs/feedback-badge-spec.md §
 * "The badge"). Fixed bottom-right, visible on every Scholars page
 * **except** the feedback form route itself.
 *
 * Click navigates to `/about/feedback?from=<current URL>`. The query
 * param tells the page route this is a **contextual** launch (the page
 * the user was on is the anchor); direct-typed navigation to
 * `/about/feedback` without `?from=` is generic mode.
 *
 * Server-side flag (`FEEDBACK_BADGE_ENABLED`) decides whether this
 * component is rendered at all — `app/layout.tsx` does that check
 * before mounting us, so by the time this client component runs the
 * decision is already settled. We do not re-read process.env here.
 */
import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";

/** Pathnames where the badge does NOT render. */
const SUPPRESSED_PREFIXES = ["/about/feedback"];

export function FeedbackBadge() {
  const router = useRouter();
  const pathname = usePathname();

  if (pathname && SUPPRESSED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }

  function onClick() {
    const here = typeof window !== "undefined" ? window.location.href : "";
    const target = here
      ? `/about/feedback?from=${encodeURIComponent(here)}`
      : "/about/feedback";
    router.push(target);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open Scholars feedback form"
      title="Help us improve Scholars"
      className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm font-medium text-foreground shadow-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <MessageSquare aria-hidden="true" className="size-4 text-muted-foreground" />
      Feedback
    </button>
  );
}
