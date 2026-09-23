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
  // a client island.
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
      <h1 className="mb-1 text-xl font-bold">Data sharing</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Dataset deposits synced from reciterdb via the weekly data-sharing bridge — aggregate
        views for research leadership, compliance/grant reporting, and the library/RDM team.
      </p>
      {/* The report streams under a body-only skeleton; keyed on the query so
          a filter or sort change shows it again. */}
      <Suspense key={JSON.stringify(ui)} fallback={<DataSharingBodySkeleton />}>
        <DataSharingBody ui={ui} />
      </Suspense>
    </ConsoleShell>
  );
}

async function DataSharingBody({ ui }: { ui: ReturnType<typeof parseDataSharingParams> }) {
  const report = await loadDataSharingReport(db.read, ui.filters);
  return <DataSharingDashboard report={report} ui={ui} />;
}

/** Stat cards, the spectrum bar and two tables — the dashboard's shape, so
 *  the swap barely shifts. The shell and title are already on screen. */
function DataSharingBodySkeleton() {
  return (
    <div aria-busy="true">
      <div role="status" className="sr-only">
        Loading data-sharing dashboard…
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border-apollo-border bg-apollo-surface rounded-md border p-4">
            <Skeleton className="mb-2 h-7 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-4 h-24 w-full rounded-md" />
      <Skeleton className="mt-10 h-48 w-full rounded-md" />
      <Skeleton className="mt-10 h-48 w-full rounded-md" />
    </div>
  );
}
