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
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { redirect } from "next/navigation";

import { AllUnitsDirectory } from "@/components/edit/all-units-directory";
import { ManageableUnitsIndex } from "@/components/edit/manageable-units-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  loadAllUnitsDirectory,
  loadAllUnitsForFinder,
  loadManageableUnits,
} from "@/lib/edit/manageable-units";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Units you manage — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function EditUnitsPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/units");
  }

  const units = await loadManageableUnits(session.cwid, db.read);
  // A superuser AND a comms_steward (a global unit-content editor, comms-steward-
  // profile-editing-spec.md §3b) both get the all-units finder AND the complete
  // org-unit directory (#971) — they may edit any existing unit, not only ones
  // they hold a grant on. Retired units stay superuser-only (the directory's
  // includeRetired below), matching the retired gate in unit-edit-context.ts.
  const canSeeAllUnitsDirectory = session.isSuperuser || session.isCommsSteward;
  const [finderUnits, directoryUnits] = await Promise.all([
    canSeeAllUnitsDirectory ? loadAllUnitsForFinder(db.read) : Promise.resolve([]),
    canSeeAllUnitsDirectory
      ? loadAllUnitsDirectory(db.read, { includeRetired: session.isSuperuser })
      : Promise.resolve([]),
  ]);

  // Back-link to the actor's own self-edit surface — only when they have a
  // (non-deleted) profile, so a staff superuser without one never hits a 404.
  const self = await db.read.scholar.findUnique({
    where: { cwid: session.cwid },
    select: { deletedAt: true },
  });
  const selfEditHref = self && self.deletedAt === null ? "/edit" : null;

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="units-index-page">
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-3 px-6">
          <span
            className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
            aria-hidden
          >
            WCM
          </span>
          <span className="font-semibold">Scholars Profile Console</span>
          {selfEditHref ? (
            <Link
              href={selfEditHref}
              className="ml-auto inline-flex items-center gap-1 text-sm text-white/80 hover:text-white"
              data-testid="units-self-edit"
            >
              <ChevronLeftIcon className="size-3.5" aria-hidden />
              My profile
            </Link>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">Units you manage</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Departments, divisions, and centers you can edit — their description, leadership, and (for
          centers) roster. Select one to edit it.
        </p>
        <ManageableUnitsIndex
          units={units}
          isSuperuser={session.isSuperuser}
          canFindAnyUnit={canSeeAllUnitsDirectory}
          finderUnits={finderUnits}
        />
        {canSeeAllUnitsDirectory && (
          <section className="mt-10">
            <AllUnitsDirectory units={directoryUnits} isSuperuser={session.isSuperuser} />
          </section>
        )}
      </main>
    </div>
  );
}
