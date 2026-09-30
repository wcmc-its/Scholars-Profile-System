/**
 * `/edit/units` — the "Units you manage" index (#753). The entry point the
 * unit-curation editor pages (#540) shipped without: it lists the org units the
 * signed-in actor may curate and links into each unit's existing editor, plus a
 * superuser finder + create affordance.
 *
 * Not superuser-gated — a unit Owner or Curator is exactly who this serves — so
 * it uses a lightweight console header + "My profile" back-link rather than the
 * superuser `AdminSubnav`. Reads the EFFECTIVE edit session (so "View as" #637
 * scopes the list to the impersonated identity, like the other unit pages).
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConsoleShell } from "@/components/edit/console-shell";
import { AllUnitsDirectory } from "@/components/edit/all-units-directory";
import { ManageableUnitsIndex } from "@/components/edit/manageable-units-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { loadAllUnitsDirectory, loadManageableUnits } from "@/lib/edit/manageable-units";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Org units — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditUnitsPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/units");
  }

  const units = await loadManageableUnits(session.cwid, db.read);
  // A superuser AND a comms_steward (a global unit-content editor, comms-steward-
  // profile-editing-spec.md §3b) both get the complete org-unit directory (#971)
  // — they may edit any existing unit, not only ones they hold a grant on.
  // Retired units stay superuser-only (the directory's includeRetired below),
  // matching the retired gate in unit-edit-context.ts.
  const canSeeAllUnitsDirectory = session.isSuperuser || session.isCommsSteward;
  const directoryUnits = canSeeAllUnitsDirectory
    ? await loadAllUnitsDirectory(db.read, { includeRetired: session.isSuperuser })
    : [];

  // The shared console tab strip (role-aware-navigation-entry-points-spec.md): the
  // "Units" tab is active here, and every other surface the viewer can open is a
  // peer tab — so `/edit/units` is no longer a navigational dead end. A superuser
  // sees the full strip; a comms_steward sees Units + Method Families; a unit
  // Owner/Curator sees Units + their My-Profile back-link (`superuserSurfaces`
  // off). The pending-request count drives the superuser "URL requests" badge.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="units"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      // `unitsTab`/`dataQualityTab`/`usageTab`/`reportsTab` no longer need a
      // per-page override here — `ConsoleShell` derives all four from `session`
      // via `loadConsoleTabs` (docs/edit-console-ia-spec.md Part B §2), which
      // already runs the same `units`/`canViewUsage`/`loadReportableUnitsForActor`
      // reads this page used to duplicate. `unitsTab` stays as a bare OR-in: this
      // page has no unit-admin gate of its own (any signed-in viewer can land
      // here), unlike the others.
      unitsTab
    >
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:min-w-[300px]">
          <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.01em]">
            Org units
          </h1>
          <p className="text-muted-foreground m-0 max-w-[80ch] text-[14.5px] leading-normal">
            {canSeeAllUnitsDirectory
              ? `Every department, division, center and core${
                  session.isSuperuser ? ", including retired ones" : ""
                }. Select a unit to edit its description, leadership and (for centers) roster.`
              : "Departments, divisions, and centers you can edit — their description, leadership, and (for centers) roster. Select one to edit it."}
          </p>
        </div>
        {/* Create a unit is superuser-only — a comms_steward edits existing units
            but never creates (or deletes) them. */}
        {session.isSuperuser && (
          <Button asChild variant="apollo">
            <Link href="/edit/unit/new" data-testid="all-units-create">
              <Plus className="size-4" aria-hidden />
              Create a unit
            </Link>
          </Button>
        )}
      </div>
      <ManageableUnitsIndex
        units={units}
        isSuperuser={session.isSuperuser}
        canFindAnyUnit={canSeeAllUnitsDirectory}
      />
      {canSeeAllUnitsDirectory && (
        <section className={units.total > 0 ? "mt-10" : undefined}>
          <AllUnitsDirectory units={directoryUnits} heading={units.total > 0} />
        </section>
      )}
    </ConsoleShell>
  );
}
