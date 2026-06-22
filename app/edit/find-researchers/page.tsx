/**
 * `/edit/find-researchers` — GrantRecs Phase 4, the "Find researchers"
 * reverse-matcher admin surface (`2026-06-20-grantrecs-phase4-design-plan.md`).
 *
 * Audience: a superuser OR a `development`-role member (`isDeveloper`). The role
 * is the dark-ship lever — the page + its data route are reachable by superusers
 * immediately, and by the development-role allowlist once `DEVELOPMENT_ENABLED`
 * is flipped on per env. A non-authorized viewer gets the Forbidden page.
 *
 * Authorization is re-checked here on every GET, never cached; the page mirrors
 * the gate the data route (`/api/opportunities/[id]/researchers`) enforces, so
 * the route remains the real authorization boundary. `force-dynamic` + `noindex`,
 * mirroring the other `/edit/*` pages. The surface folds into the shared `/edit`
 * console via `AdminSubnav` (its "Funding matcher" tab is the entry point — for
 * superusers AND development-role members alike); the account-menu dropdown no
 * longer carries a Funding-matcher row.
 */
import { redirect } from "next/navigation";
import { Eye } from "lucide-react";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { FindResearchers } from "@/components/edit/find-researchers";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { isAccountConsoleNavRestructureEnabled } from "@/lib/auth/account-console-nav";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// The tab title tracks the account-menu label (account-dropdown-nav handoff,
// Workstream B): "Funding matcher" when the unified-nav flag is on, the legacy
// "Find researchers" when off — so the dropdown and this page never disagree.
export function generateMetadata() {
  const toolName = isAccountConsoleNavRestructureEnabled() ? "Funding matcher" : "Find researchers";
  return {
    title: `${toolName} — Scholars Profile Console`,
    robots: { index: false, follow: false },
  };
}

export default async function FindResearchersPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/find-researchers");
  }
  // Superuser OR development role — the same verdict the data route reads.
  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "find-researchers",
      path: "/edit/find-researchers",
      reason: "not_developer_get",
    });
    return <ForbiddenEditPage />;
  }

  // Fold into the shared console (mirrors `/edit/methods` et al.). A superuser
  // gets the full tab set (Funding matcher rides `superuserSurfaces`); a pure
  // development-role member sees only the Funding matcher tab, shown via
  // `viewerIsDeveloper` since `superuserSurfaces` is false for them.
  const superuserSurfaces = session.isSuperuser;
  const pendingSlugRequests =
    superuserSurfaces && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const administratorsTab = superuserSurfaces && isAdministratorsTabEnabled() ? 0 : null;
  const self = await db.read.scholar.findUnique({
    where: { cwid: session.cwid },
    select: { deletedAt: true },
  });
  const selfEditHref = self && self.deletedAt === null ? "/edit" : null;

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="find-researchers-page">
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
        active="find-researchers"
        pendingSlugRequests={pendingSlugRequests}
        administratorsTab={administratorsTab}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
        viewerIsDeveloper={session.isDeveloper}
        selfEditHref={selfEditHref}
        superuserSurfaces={superuserSurfaces}
        profilesTab={session.isCommsSteward || session.isSuperuser}
        unitsTab={session.isCommsSteward || session.isSuperuser}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <Alert variant="info" className="mb-6" data-slot="funding-matcher-staff-banner">
          <Eye className="size-4" />
          <AlertDescription>
            <p>
              Available to research-development staff.
              {session.isSuperuser ? " You’re viewing as a superuser for testing." : ""}
            </p>
          </AlertDescription>
        </Alert>
        <FindResearchers unifiedNav={isAccountConsoleNavRestructureEnabled()} />
      </main>
    </div>
  );
}
