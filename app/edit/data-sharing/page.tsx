/**
 * `/edit/data-sharing` — S-Index Phase 1 admin/CTSA reporting dashboard
 * (`Data Sharing in Scholars Profile System - SPEC.md`, "Admin and CTSA
 * reporting"; 2026-08-12 dashboard plan). Read-only rollup of the SPS
 * `DatasetDeposit`/`PersonDatasetDeposit` bridge — datasets by department, by
 * repository, and by named faculty. No writes on this page.
 *
 * Global-only audience (superuser or comms_steward) — no unit scoping, unlike
 * `/edit/data-quality`; there is no natural "unit Owner sees their unit's
 * rollup" cut here. Flag-gated (`EDIT_DATA_SHARING_DASHBOARD`) — 404 when off,
 * mirroring `isDataQualityDashboardEnabled`'s dark-launch pattern. `force-dynamic`
 * + `noindex`, matching the rest of `/edit/*`.
 */
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { DataSharingDashboard } from "@/components/edit/data-sharing-dashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { loadDataSharingReport } from "@/lib/api/data-sharing-report";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { canViewDataSharingDashboard, parseDataSharingParams } from "@/lib/edit/data-sharing-dashboard";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data sharing — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditDataSharingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/data-sharing");
  }

  // Flag + role gate, combined — a dark deployment or a non-steward viewer
  // both 404 like any other unbuilt surface (the data-quality precedent).
  if (!canViewDataSharingDashboard(session)) {
    notFound();
  }

  // Year-range/tier filters + per-table sort/page (2026-08-16 ask) — every
  // value is server-parsed from the URL, no client state; see
  // `parseDataSharingParams`'s doc comment for why sort is a plain link, not
  // a client island. (The links soft-navigate; see `data-sharing-nav.tsx`.)
  const ui = parseDataSharingParams((await searchParams) ?? {});

  const [pendingSlugRequests, pendingHonors] = await Promise.all([
    isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);

  return (
    <ConsoleShell
      active="data-sharing"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <h1 className="text-[30px] leading-tight font-semibold tracking-[-.01em]">Data sharing</h1>
      <p className="text-muted-foreground mt-2.5 mb-6 max-w-[86ch] text-[14.5px] leading-normal">
        Dataset deposits synced from reciterdb by the weekly data-sharing bridge. Aggregate views
        for research leadership, compliance and grant reporting, and the library / RDM team.
      </p>
      {/* The report streams under a body-only skeleton on first load.
          Deliberately NOT keyed on the query: filter/sort/page changes are
          client-side transitions (`data-sharing-nav.tsx`), and an unchanged
          boundary lets React keep the current dashboard on screen (dimmed)
          until the new render arrives, instead of flashing the skeleton and
          collapsing the filter bar mid-click. */}
      <Suspense fallback={<DataSharingBodySkeleton />}>
        <DataSharingBody ui={ui} />
      </Suspense>
    </ConsoleShell>
  );
}

async function DataSharingBody({ ui }: { ui: ReturnType<typeof parseDataSharingParams> }) {
  const report = await loadDataSharingReport(db.read, ui.filters);
  return <DataSharingDashboard report={report} ui={ui} />;
}

/** Rail, stat tiles, the two charts and a table — the dashboard's shape, so
 *  the swap barely shifts. The shell and title are already on screen. */
function DataSharingBodySkeleton() {
  return (
    <div aria-busy="true" className="grid items-start gap-[22px] lg:grid-cols-[170px_minmax(0,1fr)]">
      <div role="status" className="sr-only">
        Loading data-sharing dashboard…
      </div>
      <Skeleton className="hidden h-80 w-full rounded-[13px] lg:block" />
      <div className="min-w-0">
        <Skeleton className="h-10 w-full rounded-md" />
        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="border-apollo-border-strong bg-apollo-surface rounded-[13px] border p-4">
              <Skeleton className="mb-2 h-3 w-24" />
              <Skeleton className="h-7 w-16" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-4 h-56 w-full rounded-[13px]" />
        <Skeleton className="mt-9 h-48 w-full rounded-[13px]" />
      </div>
    </div>
  );
}
