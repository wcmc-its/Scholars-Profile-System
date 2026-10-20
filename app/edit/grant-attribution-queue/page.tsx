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
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { GrantAttributionQueue } from "@/components/edit/grant-attribution-queue";
import { getEffectiveEditSession, impersonationActive } from "@/lib/auth/effective-identity";
import { nowSeconds } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import {
  canViewGrantAttributionQueue,
  isGrantAttributionQueueEnabled,
  isGrantAttributionQueueReadOnly,
} from "@/lib/edit/grant-attribution-queue";
import {
  countGrantAttribution,
  loadGrantAttributionQueue,
} from "@/lib/edit/grant-attribution-queue.server";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Grant attribution — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function GrantAttributionQueuePage() {
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

  // The sub-nav's other pills stay truthful on this page too.
  // The decided lists show the newest 200; the tab pills count them all.
  const [
    pending,
    confirmed,
    rejected,
    confirmedTotal,
    rejectedTotal,
    rawSession,
    pendingSlugRequests,
    pendingHonors,
  ] = await Promise.all([
    loadGrantAttributionQueue(db.read, "pending"),
    loadGrantAttributionQueue(db.read, "confirmed", { limit: 200 }),
    loadGrantAttributionQueue(db.read, "rejected", { limit: 200 }),
    countGrantAttribution(db.read, "confirmed"),
    countGrantAttribution(db.read, "rejected"),
    getSession(),
    session.isSuperuser && isSlugRequestEnabled()
      ? countPendingSlugRequests(db.read)
      : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
  ]);

  return (
    <ConsoleShell
      active="grant-attribution-queue"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      pendingGrantAttribution={pending.length}
    >
      <div className="mb-[22px] flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.01em]">Grant attribution</h1>
        <p className="text-muted-foreground m-0 max-w-[80ch] text-[14.5px] leading-normal">
          NIH awards matched to a scholar by name, where the evidence is weak or points both ways.
          Each stays off the profile until it&rsquo;s confirmed. Profiles and search update
          within minutes of a decision.
        </p>
      </div>
      <GrantAttributionQueue
        pending={pending}
        confirmed={confirmed}
        rejected={rejected}
        confirmedTotal={confirmedTotal}
        rejectedTotal={rejectedTotal}
        readOnly={isGrantAttributionQueueReadOnly(
          session,
          rawSession ? impersonationActive(rawSession, nowSeconds()) : false,
        )}
      />
    </ConsoleShell>
  );
}
