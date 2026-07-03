/**
 * `/edit/administrators` — the read-only Administrators roster (#728 Phase B,
 * `ed-admin-org-unit-roles-spec.md` § 4). Lists every `UnitAdmin` grant grouped
 * by person, showing each person's unit scope, role, and provenance. No write
 * controls — add/edit/revoke is Phase C.
 *
 * Audience (D5): superusers see ALL grants; a unit Owner sees only grants within
 * their owned subtree (resolved server-side via `loadOwnerManagedUnitScope`); a
 * non-superuser who owns no unit is Forbidden. Flag-gated behind
 * `SELF_EDIT_ADMINISTRATORS_TAB` (off ⇒ Forbidden, and the subnav hides the tab).
 *
 * Authorization is re-checked here on every GET, never cached; the query — the
 * scope passed to the roster loader — not the UI, is the scope boundary.
 * `force-dynamic` + `noindex`, mirroring the other `/edit/*` pages.
 */
import { redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { AdministratorsRoster } from "@/components/edit/administrators-roster";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { loadUnitAdministratorRoster } from "@/lib/api/administrators-roster";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession, impersonationEnabled } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  isAdministratorsTabEnabled,
  loadOwnerManagedUnitScope,
} from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Administrators — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function AdministratorsPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/administrators");
  }
  // The surface does not exist until ops enable the feature.
  if (!isAdministratorsTabEnabled()) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "administrators",
      path: "/edit/administrators",
      reason: "not_superuser_get",
    });
    return <ForbiddenEditPage />;
  }

  // Scope (D5): superuser ⇒ all grants; Owner ⇒ their owned subtree; nobody ⇒ 403.
  let scope: string[] | undefined;
  if (session.isSuperuser) {
    scope = undefined;
  } else {
    scope = await loadOwnerManagedUnitScope(session, db.read);
    if (scope.length === 0) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: "administrators",
        path: "/edit/administrators",
        reason: "not_unit_owner",
      });
      return <ForbiddenEditPage />;
    }
  }

  const { entries, nameResolutionDegraded } = await loadUnitAdministratorRoster(
    { scope },
    db.read,
  );

  // The "URL requests" admin tab + pending-count pill; `null` when the
  // slug-request feature is off (hides the tab).
  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;


  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="administrators-page">
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-3 px-6">
          <span
            className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
            aria-hidden
          >
            WCM
          </span>
          <span className="font-semibold">Scholars Profile Console</span>
        </div>
      </header>

      <AdminSubnav
        active="administrators"
        unitsTab={session.isSuperuser}
        pendingSlugRequests={pendingSlugRequests}
        administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">Administrators</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Everyone with an Owner or Curator grant on an org unit, grouped by person. Add, change a
          role, or revoke a grant from each card. Grants sourced from the{" "}
          <a
            href="https://directory.weill.cornell.edu/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--apollo-maroon)] underline"
          >
            Web Directory
          </a>{" "}
          are managed there and read-only here.
        </p>
        <AdministratorsRoster
          entries={entries}
          isSuperuser={session.isSuperuser}
          actorCwid={session.cwid}
          nameResolutionDegraded={nameResolutionDegraded}
          canImpersonate={impersonationEnabled() && session.isSuperuser}
        />
      </main>
    </div>
  );
}
