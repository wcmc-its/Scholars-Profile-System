/**
 * `/edit/titles-queue` — the display-title review queue (Queues → Titles).
 * The scholars whose displayed title needs an operator: contested, leadership
 * lost, a role the title text disagrees with, an unverified working title,
 * conflicting roles. Resolved by pinning a title (the same `/api/edit/field`
 * write as the `/edit` title picker). Formerly report 10 "Display titles"
 * under Reports; it moved here because it is pending work, like Honors /
 * News / Media highlights. The old report URLs were not redirected.
 *
 * Guard (mirrors `/edit/news-queue` and `/edit/media-highlights-queue`):
 *   - no session                           ⇒ SAML login redirect
 *   - not (isSuperuser || isCommsSteward)  ⇒ notFound() (404, not 403)
 *
 * `canReviewTitles` is exactly the pin gate (`authorizeFieldEdit`'s
 * `primaryTitle` branch), and the nav tab reads the same predicate
 * (`TAB_PREDICATES.titles`). `force-dynamic` + `noindex`, like the other
 * `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import {
  loadTitlesQueue,
  TitlesQueue,
  type TitlesQueueSearchParams,
} from "@/components/edit/titles-queue";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { canReviewTitles, rememberTitlesPendingCount } from "@/lib/edit/titles-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Titles — Scholars Console",
  robots: { index: false, follow: false },
};

const BASE_PATH = "/edit/titles-queue";

export default async function TitlesQueuePage({
  searchParams,
}: {
  searchParams?: Promise<TitlesQueueSearchParams>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=${BASE_PATH}`);
  }
  // 404 (not 403) — indistinguishable from a missing surface for a non-reviewer.
  if (!canReviewTitles(session)) notFound();

  const sp = (await searchParams) ?? {};
  const [data, pendingSlugRequests, pendingHonors] = await Promise.all([
    loadTitlesQueue(),
    session.isSuperuser && isSlugRequestEnabled()
      ? countPendingSlugRequests(db.read)
      : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);
  // The exact count this page just computed: the pill here, and the memo the
  // other console pages read, so the two agree after a pin.
  rememberTitlesPendingCount(data.counts.review);

  return (
    <ConsoleShell
      active="titles-queue"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      pendingTitles={data.counts.review}
    >
      <div className="mb-[22px] flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.01em]">Titles</h1>
        <p className="text-muted-foreground m-0 max-w-3xl text-[14.5px] leading-normal">
          Scholars whose displayed title needs a look: contested leadership titles, leadership
          titles that lost, and roles the title text disagrees with. Fix the source or pin a title.
        </p>
      </div>
      <TitlesQueue data={data} session={session} searchParams={sp} basePath={BASE_PATH} />
    </ConsoleShell>
  );
}
