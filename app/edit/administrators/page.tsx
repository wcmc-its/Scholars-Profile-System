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

import { ConsoleShell } from "@/components/edit/console-shell";
import { AdministratorsRoster } from "@/components/edit/administrators-roster";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { loadUnitAdministratorRoster } from "@/lib/api/administrators-roster";
import { getCoreList } from "@/lib/api/cores";
import { getEffectiveEditSession, impersonationEnabled } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  isAdministratorsTabEnabled,
  loadOwnerManagedUnitScope,
} from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

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
    return (
      <ConsoleShell active="administrators" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage />
      </ConsoleShell>
    );
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
      return (
        <ConsoleShell active="administrators" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage />
        </ConsoleShell>
      );
    }
  }

  // Parallelized: the roster load and the core catalog are independent reads.
  const [{ entries, nameResolutionDegraded }, allCores] = await Promise.all([
    loadUnitAdministratorRoster({ scope }, db.read),
    getCoreList(db.read),
  ]);

  // The "URL requests" admin tab + pending-count pill; `null` when the
  // slug-request feature is off (hides the tab).
  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;


  return (
    <ConsoleShell
      active="administrators"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      // No unitsTab override: the deriveConsoleTabs baseline (superuser OR
      // comms_steward) is already correct for this page. The prior
      // `unitsTab={session.isSuperuser}` REPLACED that baseline (ConsoleShell's
      // unitsTab merge is replace-not-OR) rather than narrowing it deliberately
      // — it predates ConsoleShell (#977) and was never revisited when the
      // shared baseline grew a comms_steward case, so a comms_steward who also
      // owns a unit (the only way a non-superuser steward reaches this page —
      // see the Forbidden gate above) silently lost a tab their role alone
      // already earned (docs/edit-console-ia-spec.md Gap 4b).
    >
        <h1 className="mb-1 text-xl font-semibold">Administrators</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Everyone with an Owner or Curator grant on an org unit, grouped by person. Add, change a
          role, or revoke a grant from each card. Grants sourced from the{" "}
          <a
            href="https://directory.weill.cornell.edu/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--apollo-maroon)] hover:underline"
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
          allCores={allCores}
        />
    </ConsoleShell>
  );
}
