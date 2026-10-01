import { Skeleton } from "@/components/ui/skeleton";
import { PublicationResultSkeleton } from "@/components/search/result-skeletons";

/**
 * App Router loading UI for /scholars/[slug]/co-pubs (issue #294 follow-up #3).
 *
 * Route-segment Suspense fallback shown while the ISR page resolves the mentor
 * and getAllMentorCoPublications. Mirrors MentorCoPubsRollupPage: breadcrumb,
 * header, and program-grouped publication sections. Reuses
 * PublicationResultSkeleton — a CoPubCitation row is a publication row.
 * loading.tsx receives no params, so the mentor name is skeletoned.
 */
export default function CoPubsLoading() {
  return (
    <main
      className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10"
      aria-busy="true"
    >
      <div role="status" className="sr-only">
        Loading co-authored publications…
      </div>

      {/* Breadcrumb */}
      <Skeleton className="mb-4 h-3 w-64 max-w-full" />

      {/* Header — title + subtitle, export buttons */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-80 max-w-full" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-14 rounded-md" />
          <Skeleton className="h-8 w-14 rounded-md" />
        </div>
      </div>

      {/* Program-grouped publication sections */}
      <div className="space-y-10">
        {[0, 1].map((group) => (
          <section key={group}>
            <Skeleton className="mb-3 h-5 w-44 max-w-full" />
            <div className="space-y-5">
              {[0, 1, 2].map((row) => (
                <PublicationResultSkeleton key={row} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
