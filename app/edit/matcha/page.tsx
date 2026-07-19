/**
 * `/edit/matcha` — the CTL sponsor-match surface
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2): paste a commercial
 * sponsor's description of their interest (it arrives as an email or a call,
 * not a URL), rank WCM researchers on topical fit ALONE — no stage axis, no
 * ESI demotion, unlike the Funding matcher next door.
 *
 * Audience: superuser OR development role — the same gate as
 * `/edit/find-researchers`; the data route (`/api/edit/matcha`) is the
 * real authorization boundary and re-checks it. `notFound()` while
 * `MATCHA` is off (mirrors `/edit/methods` — never reveal a dark
 * surface). `force-dynamic` + `noindex`, mirroring the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { MatchaPanel } from "@/components/edit/matcha-panel";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Matcha — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function MatchaPage() {
  if (!isMatchaEnabled()) notFound();
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/matcha");
  }
  // Superuser OR development role — the same verdict the data route reads.
  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "sponsor-match",
      path: "/edit/matcha",
      reason: "not_developer_get",
    });
    return <ForbiddenEditPage />;
  }

  // Fold into the shared console — mirrors `/edit/find-researchers`.
  const superuserSurfaces = session.isSuperuser;
  const pendingSlugRequests =
    superuserSurfaces && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;
  const administratorsTab = superuserSurfaces && isAdministratorsTabEnabled() ? 0 : null;

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="matcha-page">
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
        active="matcha"
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
        administratorsTab={administratorsTab}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
        viewerIsDeveloper={session.isDeveloper}
        superuserSurfaces={superuserSurfaces}
        profilesTab={session.isCommsSteward || session.isSuperuser}
        unitsTab={session.isCommsSteward || session.isSuperuser}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <MatchaPanel />
      </main>
    </div>
  );
}
