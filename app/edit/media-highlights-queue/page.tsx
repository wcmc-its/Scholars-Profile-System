/**
 * `/edit/media-highlights-queue` — the press-clip approval queue. Same reviewers,
 * loader and decision API as `/edit/news-queue`; its own reviewer surface
 * (`components/edit/media-highlights-queue.tsx`, Media Highlights.dc.html), filtered to rows with an
 * `outlet` (etl/news/clips.ts); approved clips publish to the profile's Media
 * Highlights section, not News. Gated additionally on MEDIA_HIGHLIGHTS_SECTION.
 *
 * What follows is the news queue's own docblock, which applies unchanged.
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

import { ConsoleShell } from "@/components/edit/console-shell";
import { MediaHighlightsQueue } from "@/components/edit/media-highlights-queue";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  isMediaHighlightsQueueEnabled,
  loadNewsQueue,
  loadNewsQueueCounts,
} from "@/lib/edit/news-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Media highlights — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function MediaHighlightsQueuePage() {
  if (!isMediaHighlightsQueueEnabled()) notFound();

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/media-highlights-queue");
  }
  // superuser OR comms_steward. 404 (not 403) — the surface must be
  // indistinguishable from a missing one for a non-reviewer.
  if (!session.isSuperuser && session.isCommsSteward !== true) notFound();

  const [pending, approved, rejected, counts] = await Promise.all([
    loadNewsQueue(db.read, "pending", "clips"),
    loadNewsQueue(db.read, "published", "clips"),
    loadNewsQueue(db.read, "rejected", "clips"),
    // The history tabs are capped, so the Approved header's totals cannot come
    // from `approved` — they are counted at the DB.
    loadNewsQueueCounts(db.read, "clips"),
  ]);

  // Sub-nav tabs — mirrors `/edit/methods`, the sibling comms surface.
  const superuserSurfaces = session.isSuperuser;
  const pendingSlugRequests =
    superuserSurfaces && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;

  return (
    <ConsoleShell
      active="media-highlights-queue"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <div className="mb-[22px] flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.01em]">Media highlights</h1>
        <p className="text-muted-foreground m-0 max-w-3xl text-[14.5px] leading-normal">
          Press clips matched to scholars. Approved clips appear in the profile&rsquo;s Media
          highlights section; &ldquo;Approve but hide&rdquo; confirms the match without showing it.
        </p>
      </div>
      <MediaHighlightsQueue
        pending={pending}
        approved={approved}
        rejected={rejected}
        counts={counts}
      />
    </ConsoleShell>
  );
}
