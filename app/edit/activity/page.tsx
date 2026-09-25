/**
 * `/edit/activity` — the fleet-wide edit-activity view: edits/day, top editors,
 * most-edited entities, and recent activity across ALL profile entities over the
 * trailing 30 days. The read-only cross-entity companion to the per-entity
 * `/edit/scholar/[cwid]/history` and `/edit/center/[code]/history` surfaces.
 *
 * Superuser-only (this exposes every editor's activity across every unit — a
 * strictly-more-privileged view than the per-entity history, which any editor
 * of that entity can see). Re-checked on every GET, never cached. The audit
 * table lives in the separate `scholars_audit` DB; if the read role lacks SELECT
 * there the read throws and we render an honest "unavailable" notice rather than
 * 500ing (the scholar-history fail-soft pattern).
 *
 * Discoverable via the admin sub-nav "Activity" tab (superuser-only, no separate
 * flag — the superuser gate is the control). Renders the standard console header
 * + AdminSubnav so it matches the other `/edit/*` admin surfaces.
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { EditActivityDashboard } from "@/components/edit/edit-activity-dashboard";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { type EditActivitySummary, loadEditActivitySummary } from "@/lib/api/edit-activity";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit activity — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditActivityPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/activity");
  }
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "activity",
      path: "/edit/activity",
      reason: "not_superuser_get",
    });
    return (
      <ConsoleShell active="activity" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  let summary: EditActivitySummary | null = null;
  let unavailable = false;
  try {
    summary = await loadEditActivitySummary(db.read);
  } catch (err) {
    unavailable = true;
    console.error(
      JSON.stringify({
        event: "edit_activity_read_failed",
        path: "/edit/activity",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return (
    <ConsoleShell
      active="activity"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      {unavailable || !summary ? (
        <>
          <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.01em]">
            Edit activity
          </h1>
          <p className="text-muted-foreground mt-8" data-testid="edit-activity-unavailable">
            Edit activity is temporarily unavailable. Please try again later or contact ITS Support
            if this persists.
          </p>
        </>
      ) : (
        <EditActivityDashboard summary={summary} />
      )}
    </ConsoleShell>
  );
}
