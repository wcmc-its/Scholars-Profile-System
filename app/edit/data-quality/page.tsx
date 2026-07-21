/**
 * `/edit/data-quality` — the Data Quality dashboard
 * (`docs/data-quality-dashboard-spec.md`).
 *
 * A read-only, prominence-sorted list of scholars and their data-quality gaps
 * (missing headshot / overview, pending COI suggestions), filterable by person
 * type, department, gap, and hidden-roles. For every `/edit` user EXCEPT a plain
 * scholar editing their own profile: a superuser or comms_steward sees ALL
 * scholars; a unit Owner/Curator sees only scholars in the unit(s) they
 * administer. Each row deep-links into `/edit/scholar/[cwid]`, which enforces its
 * own authz.
 *
 * Flag-gated (`EDIT_DATA_QUALITY_DASHBOARD`) — 404 when off. `force-dynamic` +
 * `noindex`, mirroring the rest of `/edit/*`. Authorization/scope is re-resolved
 * on every GET; the query, never the UI, is the boundary.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { DataQualityDashboard } from "@/components/edit/data-quality-dashboard";
import {
  loadDataQualityFacets,
  loadDataQualityRoster,
  parseDataQualityParams,
} from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  isDataQualityDashboardEnabled,
  isEmptyScope,
  loadDataQualityScope,
} from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data quality — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 100;

export default async function EditDataQualityPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/data-quality");
  }

  // Flag gate — a dark deployment 404s like any other unbuilt surface.
  if (!isDataQualityDashboardEnabled()) {
    notFound();
  }

  // Scope: global editor (superuser / comms_steward) → all; unit Owner/Curator →
  // their units; anyone else (a plain scholar) → empty scope → Forbidden (404).
  const scope = await loadDataQualityScope(session, db.read);
  if (isEmptyScope(scope)) {
    notFound();
  }

  // Name/CWID search, person-type + org-unit multi-selects, gap, overview-age,
  // hidden-roles, page — all parsed once here (and identically by the export route).
  const params = parseDataQualityParams((await searchParams) ?? {});

  const [roster, facets] = await Promise.all([
    loadDataQualityRoster(
      {
        scope,
        query: params.q,
        roleCategories: params.roleCategories,
        units: params.units,
        gap: params.gap,
        overviewAge: params.overviewAge,
        includeHidden: params.includeHidden,
        limit: PAGE_SIZE,
        offset: params.page * PAGE_SIZE,
      },
      db.read,
    ),
    loadDataQualityFacets(db.read),
  ]);

  // Sub-nav: a superuser sees the full strip; a comms_steward sees Profiles +
  // Units + Method Families + Data quality; a unit Owner/Curator sees Units +
  // Data quality + their My-Profile back-link.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="data-quality"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      unitsTab
      dataQualityTab={0}
    >
        <h1 className="mb-1 text-xl font-semibold">Data quality</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          {scope.all
            ? "Every scholar, most prominent first, with their profile gaps — missing headshot or overview, and unreviewed conflict-of-interest suggestions."
            : "Scholars in the units you administer, most prominent first, with their profile gaps."}{" "}
          Select a row to open that profile’s editor.
        </p>
        <DataQualityDashboard
          entries={roster.entries}
          total={roster.total}
          counts={roster.counts}
          facets={facets}
          roleCategories={params.roleCategories}
          units={params.unitValues}
          q={params.q}
          gap={params.gap}
          overviewAge={params.overviewAge}
          includeHidden={params.includeHidden}
          page={params.page}
          pageSize={PAGE_SIZE}
        />
    </ConsoleShell>
  );
}
