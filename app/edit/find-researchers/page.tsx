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

import { ConsoleShell } from "@/components/edit/console-shell";
import { FindResearchers } from "@/components/edit/find-researchers";
import { FindResearchersTabs } from "@/components/edit/find-researchers-tabs";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { logEditDenial } from "@/lib/edit/authz";
import { isGrantMatchaEnabled } from "@/lib/edit/grant-recs";
import { isOpportunityIntakeEnabled } from "@/lib/edit/opportunity-submission";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// The tab title tracks the account-menu label (account-dropdown-nav handoff,
// Workstream B) — so the dropdown and this page never disagree.
export function generateMetadata() {
  return {
    title: "Funding matcher — Scholars Profile Console",
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
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="find-researchers"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <Alert variant="info" className="mb-6" data-slot="funding-matcher-staff-banner">
        <Eye className="size-4" />
        <AlertDescription>
          <p>
            Available to research-development staff.
            {session.isSuperuser ? " You’re viewing as a superuser for testing." : ""}
          </p>
        </AlertDescription>
      </Alert>
      {/* With the intake flag on, the page splits into Browse / Submissions
          sub-tabs (the URL intake + team queue history get their own surface,
          `?tab=submissions`). Flag off → the bare matcher, no tab strip — the
          dark-ship posture unchanged. */}
      {isOpportunityIntakeEnabled() ? (
        <FindResearchersTabs grantMatcha={isGrantMatchaEnabled()} />
      ) : (
        <FindResearchers grantMatcha={isGrantMatchaEnabled()} />
      )}
    </ConsoleShell>
  );
}
