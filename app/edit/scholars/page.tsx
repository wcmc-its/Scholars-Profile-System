/**
 * `/edit/scholars` — the Profiles roster (#160 UI follow-up,
 * `self-edit-launch-spec.md` § The Profiles roster). The admin entry point to
 * *find* a profile before editing it.
 *
 * Formerly two pages: this roster and the standalone Data Quality dashboard
 * (`/edit/data-quality`, prominence sort + leadership + gap tracking). They
 * merged here — see `components/edit/profiles-roster.tsx` and
 * `lib/api/data-quality.ts` for what carried over. COI review did NOT carry
 * over: it's superuser-only and lives on its own page (`/edit/coi`,
 * `app/edit/coi/page.tsx`) so this broader-audience page never touches it.
 *
 * Superuser-gated at B2, with an org-unit-admin scope tier (B3): a unit
 * Owner/Curator sees only the scholars in the unit(s) they administer.
 * Authorization is re-checked here on every GET, never cached; the query — not
 * the UI — is the scope boundary. `force-dynamic` + `noindex`, mirroring the
 * other `/edit/*` pages.
 *
 * `gap` is sanitized to strip `"has-coi"` (falling back to `"all"`) before it
 * ever reaches `loadDataQualityRoster`, regardless of what the query string
 * asks for: `DataQualityGapFilter` is a value shared with `/edit/coi`, and a
 * crafted `?gap=has-coi` here would otherwise narrow the row set by COI
 * presence on a page that never shows a COI column at all — the same class of
 * leak the superuser-only gate on `/edit/coi` exists to prevent.
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ProfilesRoster } from "@/components/edit/profiles-roster";
import { loadDataQualityFacets, loadDataQualityRoster, parseDataQualityParams } from "@/lib/api/data-quality";
import { getEffectiveEditSession, impersonationEnabled } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { isEmptyScope, loadDataQualityScope } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profiles — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 100;

export default async function EditScholarsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/scholars");
  }
  // Roster access on every GET (B3 — the org-unit-admin tier this page shipped
  // without). Three outcomes:
  //   - superuser / comms_steward → global profile editors, `{ all: true }`,
  //     unchanged: browse and open any profile.
  //   - unit Owner/Curator → a NON-EMPTY unit scope: admitted, and the query
  //     below is filtered to it. This is the same membership rule the per-scholar
  //     editor already enforces (Amendment 4, `resolveEditableUnitViaUnitAdmin`),
  //     so the roster can no longer list a profile they'd be refused on open.
  //   - anyone else (a plain scholar) → empty scope, falls through to the
  //     superuser re-check, which emits the `edit_authz_denied` line and 403s.
  const scope = await loadDataQualityScope(session, db.read);
  if (isEmptyScope(scope)) {
    const denial = requireSuperuserGet({ session, path: "/edit/scholars", targetId: "roster" });
    if (denial !== null) {
      return (
        <ConsoleShell active="profiles" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage />
        </ConsoleShell>
      );
    }
  }

  const params = parseDataQualityParams((await searchParams) ?? {});
  // Strip "has-coi" — see the module doc comment.
  const gap = params.gap === "has-coi" ? "all" : params.gap;

  const [roster, allFacets] = await Promise.all([
    loadDataQualityRoster(
      {
        scope,
        query: params.q,
        roleCategories: params.roleCategories,
        units: params.units,
        gap,
        overviewAge: params.overviewAge,
        includeHidden: params.includeHidden,
        limit: PAGE_SIZE,
        offset: params.page * PAGE_SIZE,
      },
      db.read,
    ),
    loadDataQualityFacets(db.read),
  ]);

  // Narrow the org-unit filter dropdowns to the viewer's own scope. Without this
  // a curator is offered every department in the institution and any pick but
  // their own returns zero rows (scope AND filter) — an empty list that reads as
  // "no such people" rather than "not yours". Person-type stays global: those
  // categories are not unit-specific. Divisions nest inside their department
  // here (unlike the old flat roster facets), so a division-only curator's
  // department survives the filter too — dropping it would drop their division
  // along with it.
  const codeOf = (value: string) => value.slice(value.indexOf(":") + 1);
  const facets =
    scope.all === false
      ? {
          ...allFacets,
          departments: allFacets.departments
            .map((d) => ({
              ...d,
              divisions: d.divisions.filter((div) => scope.unitCodes.includes(codeOf(div.value))),
            }))
            .filter((d) => scope.unitCodes.includes(codeOf(d.value)) || d.divisions.length > 0),
          centers: allFacets.centers.filter((c) => scope.centerCodes.includes(codeOf(c.value))),
        }
      : allFacets;

  // The "URL requests" admin tab + pending-count pill (#497 PR-3c); `null` when
  // the slug-request feature is off, which hides the tab.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="profiles"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      // No per-page override needed for `profilesTab`/`unitsTab`/`dataQualityTab`
      // anymore — `ConsoleShell` derives all three from `session` via
      // `loadConsoleTabs` (docs/edit-console-ia-spec.md Part B §2).
    >
      <ProfilesRoster
        entries={roster.entries}
        total={roster.total}
        counts={roster.counts}
        facets={facets}
        roleCategories={params.roleCategories}
        units={params.unitValues}
        q={params.q}
        gap={gap}
        overviewAge={params.overviewAge}
        includeHidden={params.includeHidden}
        page={params.page}
        pageSize={PAGE_SIZE}
        canImpersonate={impersonationEnabled() && session.isSuperuser}
        viewerCwid={session.cwid}
      />
    </ConsoleShell>
  );
}
