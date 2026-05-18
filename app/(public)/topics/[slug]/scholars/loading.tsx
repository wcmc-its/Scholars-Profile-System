import { Skeleton } from "@/components/ui/skeleton";

/**
 * App Router loading UI for /topics/[slug]/scholars (issue #294 follow-up #3).
 *
 * Route-segment Suspense fallback shown while the ISR page resolves getTopic
 * + getTopicScholars. Mirrors TopicScholarsPage: breadcrumb, "RESEARCH AREA"
 * header, and the TopicAllScholars section (filter bar + 3-column scholar
 * list). loading.tsx receives no params, so the topic label is skeletoned.
 */
export default function TopicScholarsLoading() {
  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12" aria-busy="true">
      <div role="status" className="sr-only">
        Loading scholars…
      </div>

      {/* Breadcrumb */}
      <Skeleton className="mb-4 h-3 w-80 max-w-full" />

      {/* "RESEARCH AREA" header */}
      <div className="mb-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-2 h-8 w-96 max-w-full" />
      </div>

      {/* TopicAllScholars section */}
      <section className="mt-12">
        {/* "All scholars in this area · N" */}
        <Skeleton className="h-3 w-64 max-w-full" />

        {/* Filter bar — name search, Search button, role chips */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-full max-w-[320px] rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
          <div className="ml-auto flex flex-wrap gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-7 w-24 rounded-full" />
            ))}
          </div>
        </div>

        {/* 3-column scholar list */}
        <ul className="mt-6 columns-1 gap-x-8 sm:columns-2 lg:columns-3">
          {Array.from({ length: 15 }).map((_, i) => (
            <ScholarRowSkeleton key={i} />
          ))}
        </ul>
      </section>
    </main>
  );
}

/** Mirrors TopicAllScholars' ScholarRow — 28px avatar + name + title. */
function ScholarRowSkeleton() {
  return (
    <li className="break-inside-avoid py-2">
      <div className="flex items-start gap-3 p-1.5">
        <Skeleton className="size-7 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3 w-32 max-w-full" />
          <Skeleton className="h-2.5 w-40 max-w-full" />
        </div>
      </div>
    </li>
  );
}
