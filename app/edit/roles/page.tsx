/**
 * `/edit/roles` — the global `OrgUnitRole` vocabulary editor for the
 * `comms_steward` role (#2542 Phase 3). A SIBLING global route (parallel to
 * `/edit/methods` / `/edit/administrators`), NOT a per-scholar tab: the
 * vocabulary spans every unit of a given kind, not one unit.
 *
 * Guard, both flag and role folded into ONE call:
 *   - no session                                     ⇒ SAML login redirect
 *   - `ORG_UNIT_ROLE_CONSOLE` off, or viewer is
 *     neither superuser nor comms_steward             ⇒ `notFound()` (404,
 *     never 403 — the surface must be indistinguishable from a missing one)
 *
 * `assertTabAdmits` (`lib/edit/console-tabs.server.ts`) is the gate: it reads
 * `TAB_PREDICATES.roleVocabulary`, which itself delegates to
 * `isOrgUnitRoleConsoleTabVisible` — the SAME predicate that decides whether
 * the nav tab renders, so nav/page parity is structural rather than something
 * this page has to get right by hand a second time. This is the first caller
 * of `assertTabAdmits` in the codebase.
 *
 * `isCommsSteward` is a live, uncached LDAPS bind+search+compare (~230ms) —
 * `getEffectiveEditSession()` already resolved it ONCE into `session
 * .isCommsSteward`. Nothing below re-derives it per row, per predicate, or in
 * a loop; `session` is read once and threaded through.
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { OrgUnitRoleRoster } from "@/components/edit/org-unit-role-roster";
import { buildRoleRoster } from "@/lib/api/org-unit-roles-admin";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { assertTabAdmits } from "@/lib/edit/console-tabs.server";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Role vocabulary — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function RoleVocabularyPage() {
  // Resolve the EFFECTIVE identity (mirrors `/edit/methods` / `/edit/scholars`
  // / `/edit/administrators`), so a "View as" overlay scopes this surface to
  // the impersonated viewer rather than the real superuser standing behind it.
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/roles");
  }

  // ONE gate for both the master kill switch and the role check — nav/page
  // parity by construction (I2, `lib/edit/console-tabs.server.ts`). A 404
  // either way; the surface never reveals which half failed.
  await assertTabAdmits("roleVocabulary", session, db.read);

  const roster = await buildRoleRoster(db.read);

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="role-vocabulary"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <h1 className="mb-1 text-xl font-bold">Role vocabulary</h1>
      <p className="text-muted-foreground mb-6 max-w-3xl text-sm">
        Manage the leadership and membership role labels available for each unit kind. Renaming a
        label changes what every current holder&rsquo;s role reads on their profile and on the
        unit page; sort order and profile-title only affect display. There is no delete — a role
        with live holders stays available even if you stop using it going forward.
      </p>
      <OrgUnitRoleRoster roles={roster} />
    </ConsoleShell>
  );
}
