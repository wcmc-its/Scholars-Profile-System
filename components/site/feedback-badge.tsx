"use client";

/**
 * Site-wide feedback badge (#538, docs/feedback-badge-spec.md §
 * "The badge"). Fixed bottom-right, visible on every Scholars page
 * **except** the feedback form route itself.
 *
 * Below `sm` (640px) it collapses to an icon-only circle (#1902): a
 * fixed button always floats over whatever scrolls beneath it, so the
 * phone footprint is kept to ~40x40px. The footer reserves bottom
 * padding on mobile so its last links scroll clear of it.
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

import { useFeedbackBadgeSuppressed } from "@/components/site/feedback-badge-context";

/** Pathnames where the badge does NOT render. */
const SUPPRESSED_PREFIXES = ["/about/feedback"];

export function FeedbackBadge() {
  const router = useRouter();
  const pathname = usePathname();
  const suppressedByModal = useFeedbackBadgeSuppressed();

  if (pathname && SUPPRESSED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }
  // Any open Radix Dialog registers itself via the context; the badge
  // hides while that registration is live and re-appears on close.
  if (suppressedByModal) {
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
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-background p-2.5 text-sm font-medium text-foreground shadow-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-3.5 sm:py-2"
    >
      <MessageSquare aria-hidden="true" className="size-4 text-muted-foreground" />
      {/* Icon-only below `sm` so the badge covers less body copy on phones (#1902). */}
      <span data-testid="feedback-badge-label" className="sr-only sm:not-sr-only">
        Feedback
      </span>
    </button>
  );
}
