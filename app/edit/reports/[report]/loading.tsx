import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for /edit/reports/[report] — every report page is
 * `force-dynamic` and awaits its whole report server-side (report 7: every
 * co-pub in scope, enriched), so without this a navigation or a filter change
 * shows nothing until it resolves. Built for `/edit/reports/7` and moved here
 * with the registry (2026-09-20) — a segment has ONE loading file, so it now
 * covers all seven reports. Same shape as `app/edit/data-sharing/loading.tsx`:
 * cannot render `ConsoleShell` (needs the session the page is still
 * fetching); mirrors its `<main>` container so the swap to real content
 * barely shifts.
 */
export default function ReportLoading() {
  return (
    <div className="bg-apollo-page min-h-screen">
      <main aria-busy="true" className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <div role="status" className="sr-only">
          Loading report…
        </div>

        {/* back link, h1, description */}
        <Skeleton className="mb-4 h-3 w-20" />
        <Skeleton className="mb-2 h-6 w-56" />
        <Skeleton className="mb-1 h-3 w-full max-w-2xl" />
        <Skeleton className="h-3 w-3/4 max-w-xl" />

        {/* filter bar */}
        <Skeleton className="mt-4 h-16 w-full rounded-md" />

        {/* view tabs + totals line */}
        <div className="border-apollo-border mt-4 flex gap-4 border-b pb-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="mt-4 h-4 w-80 max-w-full" />

        {/* table */}
        <Skeleton className="mt-4 h-96 w-full rounded-md" />
      </main>
    </div>
  );
}
