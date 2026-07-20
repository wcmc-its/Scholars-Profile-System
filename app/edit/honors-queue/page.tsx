/**
 * `/edit/honors-queue` — issue #1762, the honors approval queue.
 *
 * A standalone admin page rather than a rail attribute, mirroring
 * `/edit/slug-requests`. Two reasons: the queue is CROSS-scholar (the rail edits
 * one scholar), and #1767 showed the rail's three `ReadonlyArray<AttrKey>` orders
 * are NOT compiler-enforced — a key missing there typechecks clean and silently
 * never renders. A page has no such trap.
 *
 * Gated on `isSuperuser || isHonorsCurator` on EVERY GET (the query is the
 * boundary, not the UI) and flag-gated behind `HONORS_APPROVAL_QUEUE` — off ⇒ 404,
 * mirroring the endpoint. `force-dynamic` + `noindex`, like the other `/edit/*`
 * pages.
 *
 * NOT `requireSuperuserGet`: the approver is the Research Dean's office, which
 * self-serves (#1762), so a non-superuser `honors_curator` must get in. And NOT
 * `authorizeOverviewWrite`, whose first leg is `self` — a scholar would be able to
 * approve the pending honor on their own profile. See `lib/auth/honors-curator.ts`.
 */
import { notFound, redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { HonorsQueue } from "@/components/edit/honors-queue";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
// No `countPendingHonors` here: this page has already loaded the queue, so it
// feeds the sub-nav badge from `groups` rather than paying for a second COUNT —
// the same thing `/edit/slug-requests` does with `requests.length`.
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
  // Flag first: a dark surface 404s for everyone, including superusers, before any
  // authorization is even considered.
  if (!isHonorQueueEnabled()) {
    notFound();
  }
  // `isSuperuser || isHonorsCurator` — never a bare curator read; the session route
  // reports `isDeveloper: false` for a superuser to skip a redundant LDAPS call
  // (`app/api/auth/session/route.ts`), and a bare read of any role flag inherits
  // that shape and locks superusers out.
  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return <ForbiddenEditPage />;
  }

  // All three status buckets — Pending is the working queue; Approved/Rejected are
  // read-only history (the "we should see accepted honors somewhere" ask). ~250
  // rows total on a full seed, so three small queries, not a paging concern.
  // Round 5: user-asserted honors (`source='SELF'`) get their own tab, so Known
  // loads only what a scholar did NOT enter about themselves. SELF honors are
  // created `published` and never enter the pending/rejected flow, so only the
  // published load needs splitting.
  const [groups, approved, rejected, userAsserted] = await Promise.all([
    loadHonorQueue(db.read, "pending"),
    loadHonorQueue(db.read, "published", { self: false }),
    loadHonorQueue(db.read, "rejected"),
    loadHonorQueue(db.read, "published", { self: true }),
  ]);
  const pendingCount = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const contestedCount = groups.filter((g) => g.contested).length;
  // The subnav's slug badge is a live count; keep it truthful on this page too
  // rather than passing 0 and making the tab lie.
  const slugRequests = isSlugRequestEnabled() ? await loadSlugRequestQueue(db.read) : [];

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="honors-queue-page">
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
        <div className="mb-1 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Honors approval</h1>
          {/* #1762 — the Research Dean's office exports the full record (all
              statuses) as CSV. Same gate as this page enforces the route. A plain
              <a>: /export is a CSV download route (route.ts), not a page, so
              <Link>'s client nav + prefetch would fetch the file itself. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/edit/honors-queue/export" className="text-sm hover:underline" data-testid="honors-export-link">
            Download CSV
          </a>
        </div>
        <p className="text-muted-foreground mb-6 text-sm">
          {pendingCount === 0
            ? "Honors awaiting a decision. Nothing here renders on a profile until it is approved."
            : `${pendingCount} honor${pendingCount === 1 ? "" : "s"} awaiting a decision${
                contestedCount > 0
                  ? `, including ${contestedCount} where more than one person matches the same award`
                  : ""
              }. Nothing here renders on a profile until it is approved.`}
        </p>
        <HonorsQueue pending={groups} approved={approved} rejected={rejected} userAsserted={userAsserted} />
      </main>
    </div>
  );
}
