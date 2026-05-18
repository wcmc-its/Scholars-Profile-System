import { Skeleton } from "@/components/ui/skeleton";

/**
 * Reusable search result-row skeletons (issue #294 follow-ups #1 and #3).
 *
 * Each mirrors the layout of its real counterpart so the swap from skeleton
 * to content produces minimal layout shift:
 *
 *   PeopleResultSkeleton      -> components/search/people-result-card.tsx
 *   PublicationResultSkeleton -> components/search/publication-result-row.tsx
 *   FundingResultSkeleton     -> components/search/funding-result-row.tsx
 *
 * Presentational only (no client hooks), so they render inside Server
 * Components such as loading.tsx without a "use client" boundary.
 */

/** Mirrors PeopleResultCard — 56px avatar | name/title/dept/snippet | stats. */
export function PeopleResultSkeleton() {
  return (
    <div className="grid grid-cols-[56px_1fr_auto] gap-4 border-b border-[#e3e2dd] py-5">
      <Skeleton className="h-14 w-14 rounded-full" />
      <div className="min-w-0 space-y-2">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-14" />
      </div>
    </div>
  );
}

/** Mirrors PublicationResultRow — title | journal·year | author chips | meta. */
export function PublicationResultSkeleton() {
  return (
    <div className="border-b border-[#e3e2dd] py-5">
      <Skeleton className="mb-2 h-4 w-3/4" />
      <Skeleton className="mb-3 h-3 w-52" />
      <div className="flex flex-wrap gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-28 rounded-full" />
        ))}
      </div>
      <Skeleton className="mt-3 h-3 w-60" />
    </div>
  );
}

/** Mirrors FundingResultRow — title (2 lines) + people + sponsor | award id. */
export function FundingResultSkeleton() {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-t border-[#e3e2dd] py-5">
      <div className="min-w-0 space-y-2">
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-2/3" />
        <div className="flex flex-wrap gap-2 pt-1">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-6 w-28 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-3 w-52" />
      </div>
      <div className="flex flex-col items-end gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
    </div>
  );
}
