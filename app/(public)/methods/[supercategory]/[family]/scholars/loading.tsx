import { Skeleton } from "@/components/ui/skeleton";

/**
 * App Router loading UI for /methods/[supercategory]/[family]/scholars.
 *
 * Route-segment Suspense fallback shown while the ISR page resolves getFamily +
 * getMethodScholars. Mirrors FamilyScholarsPage: breadcrumb, "METHOD" header,
 * and the MethodAllScholars section (filter bar + 3-column scholar list).
 * loading.tsx receives no params, so the family label is skeletoned.
 */
export default function FamilyScholarsLoading() {
  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12" aria-busy="true">
      <div role="status" className="sr-only">
        Loading scholars…
      </div>

      {/* Breadcrumb */}
      <Skeleton className="mb-4 h-3 w-96 max-w-full" />

      {/* "METHOD" header */}
      <div className="mb-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-8 w-96 max-w-full" />
      </div>

      {/* MethodAllScholars section */}
      <section className="mt-12">
        {/* "All scholars using this method · N" */}
        <Skeleton className="h-3 w-72 max-w-full" />

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

/** Mirrors MethodAllScholars' ScholarRow — 28px avatar + name + title. */
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
