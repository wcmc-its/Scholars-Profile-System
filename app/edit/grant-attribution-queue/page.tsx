/**
 * `/edit/grant-attribution-queue` — #3071, the RePORTER grant attribution queue.
 *
 * Awards from a name-linked NIH profile that the attribution scorer
 * (`etl/reporter-grants/score.ts`) could not settle. Each stays hidden from the
 * profile until a curator confirms it or marks it "Not this person".
 *
 * Order of checks, every GET: session, then the flag (off ⇒ 404 for everyone,
 * superusers included), then `canViewGrantAttributionQueue`, the same function
 * the console tab uses. Superuser and comms_steward decide; observers and
 * content editors read. `force-dynamic` + `noindex` like every `/edit` page.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { GrantAttributionBoard } from "@/components/edit/grant-attribution-board";
import { GRANT_ATTRIBUTION_REPORT_HREF } from "@/components/edit/grant-attribution-shared";
import { getEffectiveEditSession, impersonationActive } from "@/lib/auth/effective-identity";
import { nowSeconds } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { fromDecidedRow, fromQueueItem, type BoardTab } from "@/lib/edit/grant-attribution-board";
import { parseDecidedParams, parseQueueTab } from "@/lib/edit/grant-attribution-decided";
import { loadDecidedPage } from "@/lib/edit/grant-attribution-decided.server";
import {
  canViewGrantAttributionQueue,
  isGrantAttributionQueueEnabled,
  isGrantAttributionQueueReadOnly,
} from "@/lib/edit/grant-attribution-queue";
import {
  loadGrantAttributionQueue,
  loadGrantAttributionRuns,
  loadUnprovenQueueItems,
} from "@/lib/edit/grant-attribution-queue.server";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Grant attribution — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function GrantAttributionQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/grant-attribution-queue");
  }
  if (!isGrantAttributionQueueEnabled()) {
    notFound();
  }
  if (!canViewGrantAttributionQueue(session)) {
    return (
      <ConsoleShell
        active="grant-attribution-queue"
        session={session}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const sp = await searchParams;
  const parsed = parseQueueTab(sp);
  // An old ?tab=unproven link lands on To review, where those awards now are.
  // Unproven awards are listed in To review, beside the pending reviews.
  const tab: BoardTab = parsed === "unproven" ? "pending" : parsed;
  const params = parseDecidedParams(sp, tab === "pending" ? "confirmed" : tab);
  const runs = await loadGrantAttributionRuns(db.read, 2);
  // The sub-nav's other pills stay truthful on this page too.
  const [pending, decided, rawSession, pendingSlugRequests, pendingHonors] = await Promise.all([
    loadGrantAttributionQueue(db.read, "pending"),
    // On To review this is only for the tab counts.
    loadDecidedPage(db.read, params, runs, { hydrate: tab !== "pending" }),
    getSession(),
    session.isSuperuser && isSlugRequestEnabled()
      ? countPendingSlugRequests(db.read)
      : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);
  const readOnly = isGrantAttributionQueueReadOnly(
    session,
    rawSession ? impersonationActive(rawSession, nowSeconds()) : false,
  );
  const unproven = tab === "pending" ? await loadUnprovenQueueItems(db.read, decided.unprovenIds) : [];
  const run = runs[0] ?? null;
  const since = runs[1]?.ranAt ?? null;
  const counts: Record<BoardTab, number> = {
    pending: pending.length + decided.counts.unproven.all,
    confirmed: decided.counts.confirmed.all,
    rejected: decided.counts.rejected.all,
  };
  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <ConsoleShell
      active="grant-attribution-queue"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      pendingGrantAttribution={pending.length}
    >
      <div className="mb-7 flex flex-col gap-2.5">
        <h1 className="m-0 text-[34px] font-semibold tracking-[-0.01em] max-md:text-[24px]">
          Grant attribution
        </h1>
        <p className="m-0 max-w-[74ch] text-[15px] leading-normal text-pretty text-[var(--evidence-body)]">
          NIH awards RePORTER links to a scholar. A weekly check weighs each one; the ones it can&rsquo;t
          settle wait here. Profiles and search update within minutes of a decision.
        </p>
        <p
          className="m-0 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[13px] text-[var(--evidence-faint)]"
          data-testid="grant-attribution-run-summary"
        >
          {run ? (
            <span>
              Weekly check ran{" "}
              <strong className="text-foreground font-medium">
                {new Date(run.ranAt).toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  timeZone: "America/New_York",
                })}
              </strong>{" "}
              · {fmt(run.show + run.hide + run.queue)} awards across {fmt(run.scholars)} scholars
              {decided.changed.confirmed > 0 ? (
                <>
                  {" "}
                  ·{" "}
                  <Link href="?tab=confirmed&changed=1">
                    {fmt(decided.changed.confirmed)} shown again since the previous run
                  </Link>
                </>
              ) : null}
            </span>
          ) : (
            <span>The weekly check hasn&rsquo;t run yet.</span>
          )}
          <span className="flex gap-5">
            <Link href={`${GRANT_ATTRIBUTION_REPORT_HREF}#method`}>How the check works</Link>
            <Link href={GRANT_ATTRIBUTION_REPORT_HREF}>Full report</Link>
          </span>
        </p>
      </div>

      {readOnly ? (
        <p className="border-apollo-border-strong bg-apollo-surface-2 m-0 mb-4 rounded-lg border px-3 py-[9px] text-[13.5px] text-[#3a3532]">
          You can see every decision and its evidence. Curators can change them.
        </p>
      ) : null}

      {tab === "pending" ? (
        <GrantAttributionBoard
          key={tab}
          tab={tab}
          rows={[...pending, ...unproven].map((it) => fromQueueItem(it, since))}
          counts={counts}
          readOnly={readOnly}
          server={null}
        />
      ) : (
        <GrantAttributionBoard
          key={tab}
          tab={tab}
          rows={decided.rows.map(fromDecidedRow)}
          counts={counts}
          readOnly={readOnly}
          server={{
            params,
            matched: decided.matched,
            byCounts: { curator: decided.counts[tab].curator, auto: decided.counts[tab].auto },
            changed: decided.changed[tab],
          }}
        />
      )}
    </ConsoleShell>
  );
}
