/**
 * "Requests to review" — the pending Profile-URL requests card at the top of
 * `/edit/slugs` (Profile URLs; #497 PR-3c, U3, `slug-personalization-ui-spec.md`
 * § 3). The client island owns the visible row set so a decided request
 * (approved or denied) drops out immediately — and the count badge with it —
 * and calls `router.refresh()` to reconcile the server view (pending-count
 * pill, the registry tabs, any newly-filed requests).
 *
 * The row interactivity lives in `slug-request-row.tsx`; this component is the
 * card header, the list and the empty state.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { SlugRequestRow } from "@/components/edit/slug-request-row";
import type { SlugRequestQueueRow } from "@/lib/edit/slug-request";
import { cn } from "@/lib/utils";

/** "Sep 18, 2026". */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function SlugRequestQueue({
  initialRequests,
  lastDecidedAt = null,
}: {
  initialRequests: SlugRequestQueueRow[];
  /** ISO time of the most recent decision, for the empty state. */
  lastDecidedAt?: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<SlugRequestQueueRow[]>(initialRequests);

  function handleDecided(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    router.refresh();
  }

  return (
    <section
      aria-labelledby="slug-requests-heading"
      className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border"
    >
      <div className="border-apollo-border flex flex-wrap items-center gap-3 border-b px-5 py-3.5">
        <h2 id="slug-requests-heading" className="text-base font-semibold">
          Requests to review
        </h2>
        <span
          className={cn(
            "rounded-full px-[9px] py-0.5 text-[12.5px] font-semibold tabular-nums",
            rows.length > 0
              ? "bg-apollo-amber-tint text-apollo-amber"
              : "bg-apollo-surface-2 text-muted-foreground",
          )}
          data-testid="slug-request-count"
        >
          {rows.length}
        </span>
        <span className="text-muted-foreground min-w-0 flex-[1_1_280px] text-[13px] sm:text-right">
          Oldest first. Approving pins the URL and redirects the old one.
        </span>
      </div>
      {rows.length === 0 ? (
        <p
          className="text-muted-foreground px-5 py-4 text-sm"
          data-testid="slug-request-queue-empty"
        >
          No pending requests.
          {lastDecidedAt ? ` Last decided ${formatShortDate(lastDecidedAt)}.` : ""}
        </p>
      ) : (
        <ul data-testid="slug-request-queue">
          {rows.map((r) => (
            <li key={r.id} className="border-apollo-border border-b last:border-b-0">
              <SlugRequestRow request={r} onDecided={handleDecided} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
