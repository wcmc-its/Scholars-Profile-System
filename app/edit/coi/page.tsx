/**
 * `/edit/coi` — the COI (conflict-of-interest) dashboard. Superuser-only, and
 * only when `EDIT_DATA_QUALITY_DASHBOARD` is on — unlike Profiles, there is no
 * comms_steward or unit Owner/Curator tier here at all, so scope is always
 * `{ all: true }` and there's nothing to resolve via `loadDataQualityScope`.
 *
 * A prominence-sorted list of scholars with pending COI-review counts. Split
 * out of the merged Profiles page (`/edit/scholars`) so COI review — the one
 * genuinely sensitive signal in this data set — lives somewhere a
 * comms_steward or unit admin can never reach, on-screen or via a crafted
 * query param (see `gap` sanitization below and in the export route).
 *
 * `force-dynamic` + `noindex`, mirroring the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { CoiRoster } from "@/components/edit/coi-roster";
import { loadDataQualityFacets, loadDataQualityRoster, parseDataQualityParams } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isDataQualityDashboardEnabled } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "COI — Scholars Profile Console",
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
  // Superuser + flag only — a dark deployment or a non-superuser 404s like any
  // other unbuilt surface, never revealing that the route exists.
  if (!session.isSuperuser || !isDataQualityDashboardEnabled()) {
    notFound();
  }

  const params = parseDataQualityParams((await searchParams) ?? {});
  // Strip "no-headshot"/"no-overview" — those are Profiles-only dimensions
  // this page never renders (module doc comment on `lib/api/data-quality.ts`).
  const gap = params.gap === "has-coi" ? "has-coi" : "all";

  const [roster, facets] = await Promise.all([
    loadDataQualityRoster(
      {
        scope: { all: true },
        query: params.q,
        roleCategories: params.roleCategories,
        units: params.units,
        gap,
        includeHidden: params.includeHidden,
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
        includeHidden={params.includeHidden}
        page={params.page}
        pageSize={PAGE_SIZE}
      />
    </ConsoleShell>
  );
}
