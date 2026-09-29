import { Skeleton } from "@/components/ui/skeleton";

/**
 * App Router loading UI for /topics/[slug]/scholars (issue #294 follow-up #3).
 *
 * Route-segment Suspense fallback shown while the ISR page resolves. Mirrors
 * TopicScholarsPage: breadcrumb, header, the sticky filter bar (name filter,
 * Subarea picker, role chips, A–Z bar) and one letter group of cards.
 * loading.tsx receives no params, so the topic label is skeletoned.
 */
export default function TopicScholarsLoading() {
  return (
    <main className="mx-auto max-w-[1160px] px-6 pt-7 pb-18 sm:px-10" aria-busy="true">
      <div role="status" className="sr-only">
        Loading scholars…
      </div>

      <Skeleton className="h-3 w-80 max-w-full" />

      <div className="mt-5 flex flex-col gap-2.5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-10 w-[28rem] max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <Skeleton className="h-[38px] w-full max-w-[360px] rounded-lg" />
        <Skeleton className="h-[38px] w-48 rounded-lg" />
        <div className="ml-auto flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <Skeleton className="mt-3.5 h-[34px] w-full" />

      <Skeleton className="mt-7 h-7 w-10" />
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-x-5 gap-y-4">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="size-12 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56 max-w-full" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
