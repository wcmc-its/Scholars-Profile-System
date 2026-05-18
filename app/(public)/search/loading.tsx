import { Skeleton } from "@/components/ui/skeleton";
import { PeopleResultSkeleton } from "@/components/search/result-skeletons";

/**
 * App Router loading UI for /search (issue #294 follow-up #1).
 *
 * Next.js renders this as the route-segment Suspense fallback on first paint
 * and any uncached navigation to /search, while the force-dynamic SearchPage
 * awaits its three parallel backend queries (searchPeople / searchPublications
 * / searchFunding).
 *
 * loading.tsx receives no searchParams, so it cannot know the active tab. The
 * result rows therefore use the People shape — `type` defaults to "people"
 * and a fresh search submitted from the autocomplete box lands on that tab —
 * while the shell (search-meta, mode tabs, facet rail, results toolbar) is
 * tab-agnostic. Every container matches SearchPage's so the swap to real
 * content produces minimal layout shift.
 */
export default function SearchLoading() {
  return (
    <main aria-busy="true">
      <div role="status" className="sr-only">
        Loading search results…
      </div>

      {/* SearchMeta — h1 + counts subhead */}
      <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
        <Skeleton className="mb-2 h-7 w-72" />
        <Skeleton className="h-3 w-60" />
      </div>

      {/* ModeTabs — Scholars / Publications / Funding */}
      <div className="mx-auto flex max-w-[1280px] gap-1 border-b border-[#e3e2dd] px-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-[42px] items-center gap-2 px-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-8 rounded-full" />
          </div>
        ))}
      </div>

      {/* Facet rail + results column */}
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-6 pt-6 pb-16 md:grid-cols-[240px_1fr]">
        <FacetRailSkeleton />
        <div>
          {/* ResultsToolbar — count line + sort control */}
          <div className="mb-2 flex items-center justify-between border-b border-[#e3e2dd] pb-3">
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-3 w-36" />
          </div>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <PeopleResultSkeleton key={i} />
          ))}
        </div>
      </div>
    </main>
  );
}

/** Mirrors the FacetSidebar <aside> — "Filters" header + facet groups. */
function FacetRailSkeleton() {
  return (
    <aside className="text-[13px]">
      <div className="mb-4">
        <Skeleton className="h-3 w-16" />
      </div>
      {[5, 4, 3].map((rowCount, group) => (
        <div key={group} className="mb-5 space-y-2.5">
          <Skeleton className="h-3 w-32" />
          {Array.from({ length: rowCount }).map((_, row) => (
            <Skeleton key={row} className="h-3 w-full" />
          ))}
        </div>
      ))}
    </aside>
  );
}
