/**
 * `/edit/honors-queue` — issue #1762, the honors approval queue.
 *
 * A standalone admin page rather than a rail attribute, mirroring
 * `/edit/slug-requests`. Two reasons: the queue is CROSS-scholar (the rail edits
 * one scholar), and #1767 showed the rail's three `ReadonlyArray<AttrKey>` orders
 * are NOT compiler-enforced — a key missing there typechecks clean and silently
 * never renders. A page has no such trap.
 *
 * Superuser-gated on every GET (the query is the boundary, not the UI) and
 * flag-gated behind `HONORS_APPROVAL_QUEUE` — off ⇒ 404, mirroring the endpoint.
 * `force-dynamic` + `noindex`, like the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { HonorsQueue } from "@/components/edit/honors-queue";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { isHonorQueueEnabled, loadHonorQueue } from "@/lib/edit/honor-queue";
import { isSlugRequestEnabled, loadSlugRequestQueue } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Honors approval — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function HonorsQueuePage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/honors-queue");
  }
  const denial = requireSuperuserGet({
    session,
    path: "/edit/honors-queue",
    targetId: "honors-queue",
  });
  if (denial !== null) {
    return <ForbiddenEditPage />;
  }
  if (!isHonorQueueEnabled()) {
    notFound();
  }

  const groups = await loadHonorQueue(db.read);
  const pendingCount = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const contestedCount = groups.filter((g) => g.contested).length;
  // The subnav's slug badge is a live count; keep it truthful on this page too
  // rather than passing 0 and making the tab lie.
  const slugRequests = isSlugRequestEnabled() ? await loadSlugRequestQueue(db.read) : [];

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="honors-queue-page">
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
        active="honors-queue"
        unitsTab={session.isSuperuser}
        pendingSlugRequests={slugRequests.length}
        pendingHonors={pendingCount}
        administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">Honors approval</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          {pendingCount === 0
            ? "Honors awaiting a decision. Nothing here renders on a profile until it is approved."
            : `${pendingCount} honor${pendingCount === 1 ? "" : "s"} awaiting a decision${
                contestedCount > 0
                  ? `, including ${contestedCount} where more than one person matches the same award`
                  : ""
              }. Nothing here renders on a profile until it is approved.`}
        </p>
        <HonorsQueue initialGroups={groups} />
      </main>
    </div>
  );
}
