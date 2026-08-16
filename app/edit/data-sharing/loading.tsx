import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-segment loading UI for /edit/data-sharing — the page is
 * `force-dynamic` and awaits the full report server-side, so without this
 * a navigation shows nothing until the report resolves (the explicit
 * complaint behind the 08-16 design pass). Cannot render `ConsoleShell`
 * (needs the session the page is still fetching); mirrors its `<main>`
 * container so the swap to real content produces minimal layout shift.
 */
export default function DataSharingLoading() {
  return (
    <div className="bg-apollo-page min-h-screen">
      <main aria-busy="true" className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <div role="status" className="sr-only">
          Loading data-sharing dashboard…
        </div>

        {/* h1 + subtitle */}
        <Skeleton className="mb-2 h-6 w-40" />
        <Skeleton className="mb-6 h-3 w-96 max-w-full" />

        {/* §1 stat cards */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="border-apollo-border bg-apollo-surface rounded-md border p-4">
              <Skeleton className="mb-2 h-7 w-16" />
              <Skeleton className="h-3 w-28" />
            </div>
          ))}
        </div>

        {/* Spectrum bar card + two table blocks */}
        <Skeleton className="mt-4 h-24 w-full rounded-md" />
        <Skeleton className="mt-10 h-48 w-full rounded-md" />
        <Skeleton className="mt-10 h-48 w-full rounded-md" />
      </main>
    </div>
  );
}
