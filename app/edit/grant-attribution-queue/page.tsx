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
import { DecidedAwards } from "@/components/edit/grant-attribution-decided";
import { GrantAttributionQueue } from "@/components/edit/grant-attribution-queue";
import { GRANT_ATTRIBUTION_REPORT_HREF } from "@/components/edit/grant-attribution-shared";
import { getEffectiveEditSession, impersonationActive } from "@/lib/auth/effective-identity";
import { nowSeconds } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import {
  parseDecidedParams,
  parseQueueTab,
  type DecidedTab,
} from "@/lib/edit/grant-attribution-decided";
import { loadDecidedPage } from "@/lib/edit/grant-attribution-decided.server";
import {
  canViewGrantAttributionQueue,
  isGrantAttributionQueueEnabled,
  isGrantAttributionQueueReadOnly,
} from "@/lib/edit/grant-attribution-queue";
import {
  loadGrantAttributionQueue,
  loadGrantAttributionRuns,
} from "@/lib/edit/grant-attribution-queue.server";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Grant attribution — Scholars Console",
  robots: { index: false, follow: false },
};

const TABS: ReadonlyArray<readonly ["pending" | DecidedTab, string]> = [
  ["pending", "To review"],
  ["confirmed", "Confirmed"],
  ["rejected", "Not this person"],
  ["unproven", "Unproven"],
];

const INTRO: Record<"pending" | DecidedTab, string> = {
  pending: "Evidence is weak or points both ways. Each stays off the profile until a curator decides.",
  confirmed:
    "On the profile. The weekly check can move an Auto-confirmed award if evidence against it turns up; curator confirmations never change on their own.",
  rejected:
    "Kept off the profile because evidence points to someone else. Curator rejections never change on their own.",
  unproven:
    "Nothing found either way. Kept off the profile and checked again every week; an award moves to Confirmed on its own if evidence turns up.",
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
  const tab = parseQueueTab(sp);
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
  const run = runs[0] ?? null;
  const count = (t: "pending" | DecidedTab) => (t === "pending" ? pending.length : decided.counts[t].all);
  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <ConsoleShell
      active="grant-attribution-queue"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      pendingGrantAttribution={pending.length}
    >
      <div className="mb-4 flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.01em] max-md:text-[24px]">Grant attribution</h1>
        <p className="text-muted-foreground m-0 max-w-[720px] text-[14.5px] leading-normal">
          NIH awards RePORTER links to a scholar. A weekly check weighs each one; the ones it can&rsquo;t
          settle wait here. Profiles and search update within minutes of a decision.
        </p>
      </div>

      <p
        className="m-0 mb-4 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13.5px] text-[#3a3532]"
        data-testid="grant-attribution-run-summary"
      >
        {run ? (
          <span>
            Weekly check ran{" "}
            <strong className="font-semibold">
              {new Date(run.ranAt).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                timeZone: "America/New_York",
              })}
            </strong>{" "}
            · {fmt(run.show + run.hide + run.queue)} awards across {fmt(run.scholars)} scholars
            {decided.changed > 0 ? (
              <>
                {" "}
                ·{" "}
                <Link href="?tab=confirmed&changed=1">
                  {fmt(decided.changed)} shown again since the previous run
                </Link>
              </>
            ) : null}
          </span>
        ) : (
          <span>The weekly check hasn&rsquo;t run yet.</span>
        )}
        <span className="flex gap-3.5 md:ml-auto">
          <Link href={`${GRANT_ATTRIBUTION_REPORT_HREF}#method`}>How the check works</Link>
          <Link href={GRANT_ATTRIBUTION_REPORT_HREF}>Full report</Link>
        </span>
      </p>

      {readOnly ? (
        <p className="border-apollo-border-strong bg-apollo-surface-2 m-0 mb-4 rounded-lg border px-3 py-[9px] text-[13.5px] text-[#3a3532]">
          You can see every decision and its evidence. Curators can change them.
        </p>
      ) : null}

      <nav
        aria-label="Grant attribution"
        className="border-apollo-border-strong mb-3 flex gap-x-7 overflow-x-auto border-b whitespace-nowrap max-md:-mx-4 max-md:gap-x-5 max-md:px-4"
      >
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={t === "pending" ? "?" : `?tab=${t}`}
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-0.5 text-[15px] no-underline",
              tab === t
                ? "border-apollo-maroon text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-testid={`grant-attribution-tab-${t}`}
          >
            {label}
            <span
              className={cn(
                "rounded-full px-[7px] py-px text-xs font-semibold tabular-nums",
                tab === t ? "bg-apollo-maroon text-white" : "bg-apollo-surface-2 text-[#3a3532]",
              )}
            >
              {fmt(count(t))}
            </span>
          </Link>
        ))}
      </nav>
      <p className="m-0 mb-4 text-[13.5px] text-[#3a3532]">{INTRO[tab]}</p>

      {tab === "pending" ? (
        <GrantAttributionQueue pending={pending} readOnly={readOnly} />
      ) : (
        <DecidedAwards key={tab} page={decided} readOnly={readOnly} />
      )}
    </ConsoleShell>
  );
}
