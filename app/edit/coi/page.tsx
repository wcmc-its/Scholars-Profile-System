/**
 * `/edit/coi` — the COI (conflict-of-interest) dashboard, only when
 * `EDIT_DATA_QUALITY_DASHBOARD` is on. Scope is always `{ all: true }`, so
 * there's nothing to resolve via `loadDataQualityScope`.
 *
 * A prominence-sorted list of scholars with pending COI-review counts. COI is
 * public data (decision 2026-10-01): superusers, observers and content
 * editors see it by birthright, anyone else by an ad hoc Reporting grant
 * (`canViewDashboard`, `lib/edit/dashboard-access.ts`). The page has no
 * actions. Two things stay superuser-only: students & alumni (no public
 * profile) and the CSV export (a bulk scholar export). See `gap`
 * sanitization below and in the export route.
 *
 * `force-dynamic` + `noindex`, mirroring the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { CoiRoster } from "@/components/edit/coi-roster";
import { loadDataQualityFacets, loadDataQualityRoster, parseDataQualityParams } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { canViewDashboard } from "@/lib/edit/dashboard-access";
import { db } from "@/lib/db";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "COI — Scholars Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 100;

export default async function EditCoiPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/coi");
  }
  // Flag + `canViewDashboard` (superuser, observer, content editor, or an ad
  // hoc grant) — anyone else 404s, never revealing that the route exists.
  if (!(await canViewDashboard(session, "coi"))) {
    notFound();
  }

  const params = parseDataQualityParams((await searchParams) ?? {});
  // Strip "no-headshot"/"no-overview" — those are Profiles-only dimensions
  // this page never renders (module doc comment on `lib/api/data-quality.ts`).
  const gap = params.gap === "has-coi" ? "has-coi" : "all";
  // Students & alumni have no public profile: only a superuser can include
  // them. Everyone else gets the public set (COI is public data, 2026-10-01).
  const includeHidden = session.isSuperuser && params.includeHidden;

  const [roster, facets] = await Promise.all([
    loadDataQualityRoster(
      {
        scope: { all: true },
        query: params.q,
        roleCategories: params.roleCategories,
        unitValues: params.unitValues,
        gap,
        includeHidden,
        limit: PAGE_SIZE,
        offset: params.page * PAGE_SIZE,
      },
      db.read,
    ),
    loadDataQualityFacets(db.read),
  ]);

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;

  return (
    <ConsoleShell active="coi" session={session} pendingSlugRequests={pendingSlugRequests} pendingHonors={pendingHonors}>
      <CoiRoster
        entries={roster.entries}
        total={roster.total}
        counts={roster.counts}
        facets={facets}
        roleCategories={params.roleCategories}
        units={params.unitValues}
        q={params.q}
        gap={gap}
        includeHidden={includeHidden}
        page={params.page}
        pageSize={PAGE_SIZE}
        fullAccess={session.isSuperuser}
      />
    </ConsoleShell>
  );
}
