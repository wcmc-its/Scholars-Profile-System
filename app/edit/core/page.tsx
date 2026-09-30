/**
 * `/edit/core` — the cores review-queue index. One summary row per core
 * facility (review backlog, confirmed count, clients, staff-feed coverage,
 * leaders, owners, public state — `loadCoreConsoleIndex`), each linking to its
 * owner review queue (`/edit/core/[coreId]/review`) and its editor
 * (`/edit/core/[coreId]`). Reached from the "Cores" tab in the admin sub-nav.
 *
 * Audience: superuser or comms_steward (2026-08-26 policy widening, decision
 * #6 — full curator-parity on cores, `comms-steward-profile-editing-spec.md`
 * §11) — the admin-toolbar tab is the entry point and is gated the same way
 * (`TAB_PREDICATES.cores`). A non-superuser, non-steward core owner/curator
 * still reaches THEIR queue via the per-core deep link (`/edit/core/[coreId]`,
 * auth-gated on `getCoreOwnerRole`); an owner-scoped index is a future add
 * (the account-menu entry point). `force-dynamic` + `noindex`, mirroring the
 * rest of `/edit/*`.
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { CoreFacilitiesIndex } from "@/components/edit/core-facilities-index";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { loadCoreConsoleIndex } from "@/lib/api/core-console-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { isCorePagesEnabled, isCorePubModalEnabled } from "@/lib/profile/cores-flags";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cores — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function EditCoresIndexPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/core");
  }
  if (!session.isSuperuser && !session.isCommsSteward) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "core",
      path: "/edit/core",
      reason: "not_superuser_get",
    });
    return (
      <ConsoleShell active="cores" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const cores = await loadCoreConsoleIndex(db.read);
  // The public-surface flags a core ALSO needs (beside its own `visible`
  // toggle) to show publicly. Names only — never a value — reach the client.
  const offFlags = [
    ...(isCorePagesEnabled() ? [] : ["CORE_PAGES"]),
    ...(isCorePubModalEnabled() ? [] : ["CORE_PUB_MODAL"]),
  ];

  // The "URL requests" admin tab + pending-count pill; `null` when the
  // slug-request feature is off (hides the tab). Mirrors the sibling console pages.
  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="cores"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <div className="mb-5 flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.01em]">
          Core facilities
        </h1>
        <p className="text-muted-foreground m-0 max-w-[84ch] text-[14.5px] leading-normal">
          Review engine-suggested publications for each core. Confirmed publications appear on the
          public core page; rejected ones are hidden. A core with no staff feed yet has nothing to
          review.
        </p>
      </div>
      <CoreFacilitiesIndex cores={cores} offFlags={offFlags} />
    </ConsoleShell>
  );
}
