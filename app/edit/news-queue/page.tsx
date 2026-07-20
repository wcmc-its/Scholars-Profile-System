/**
 * `/edit/news-queue` — the news-mentions approval queue (comms surface).
 *
 * A standalone admin page (like `/edit/honors-queue`), not a rail attribute: the
 * queue is CROSS-scholar. etl/news auto-publishes VIVO-linked mentions but leaves
 * prose name-matches PENDING; comms confirms those here before they reach a
 * public profile. A name that matched >1 scholar is a contested single-select.
 *
 * Guard (mirrors `/edit/methods`, the other comms surface):
 *   - `NEWS_APPROVAL_QUEUE` off              ⇒ notFound() (404 — never reveal it)
 *   - no session                             ⇒ SAML login redirect
 *   - not (isSuperuser || isCommsSteward)    ⇒ notFound() (404, not 403)
 *
 * External comms IS the comms-steward function, so the same `isCommsSteward`
 * gate the profile-editing surfaces use authorizes this queue. `force-dynamic` +
 * `noindex`, like the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { NewsQueue } from "@/components/edit/news-queue";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { isNewsQueueEnabled, loadNewsQueue } from "@/lib/edit/news-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "News approval — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function NewsQueuePage() {
  if (!isNewsQueueEnabled()) notFound();

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/news-queue");
  }
  // superuser OR comms_steward. 404 (not 403) — the surface must be
  // indistinguishable from a missing one for a non-reviewer.
  if (!session.isSuperuser && session.isCommsSteward !== true) notFound();

  const [pending, approved, rejected] = await Promise.all([
    loadNewsQueue(db.read, "pending"),
    loadNewsQueue(db.read, "published"),
    loadNewsQueue(db.read, "rejected"),
  ]);
  const pendingCount = pending.reduce((sum, g) => sum + g.rows.length, 0);
  const contestedCount = pending.filter((g) => g.contested).length;

  // Sub-nav tabs — mirrors `/edit/methods`, the sibling comms surface.
  const superuserSurfaces = session.isSuperuser;
  const pendingSlugRequests =
    superuserSurfaces && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;
  const administratorsTab = superuserSurfaces && isAdministratorsTabEnabled() ? 0 : null;

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="news-queue-page">
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
        active="news-queue"
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
        administratorsTab={administratorsTab}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
        superuserSurfaces={superuserSurfaces}
        profilesTab={session.isCommsSteward || session.isSuperuser}
        unitsTab={session.isCommsSteward || session.isSuperuser}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">News approval</h1>
        <p className="text-muted-foreground mb-6 max-w-3xl text-sm">
          {pendingCount === 0
            ? "News mentions detected by name (not a VIVO link) awaiting confirmation. Nothing here shows on a profile until it is approved."
            : `${pendingCount} name-matched mention${pendingCount === 1 ? "" : "s"} awaiting confirmation${
                contestedCount > 0
                  ? `, including ${contestedCount} where more than one scholar matches the same name`
                  : ""
              }. Nothing here shows on a profile until it is approved.`}
        </p>
        <NewsQueue pending={pending} approved={approved} rejected={rejected} />
      </main>
    </div>
  );
}
