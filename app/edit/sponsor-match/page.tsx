/**
 * `/edit/sponsor-match` — the CTL sponsor-match surface
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2): paste a commercial
 * sponsor's description of their interest (it arrives as an email or a call,
 * not a URL), rank WCM researchers on topical fit ALONE — no stage axis, no
 * ESI demotion, unlike the Funding matcher next door.
 *
 * Audience: superuser OR development role — the same gate as
 * `/edit/find-researchers`; the data route (`/api/edit/sponsor-match`) is the
 * real authorization boundary and re-checks it. `notFound()` while
 * `SPONSOR_MATCH` is off (mirrors `/edit/methods` — never reveal a dark
 * surface). `force-dynamic` + `noindex`, mirroring the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SponsorMatchPanel } from "@/components/edit/sponsor-match-panel";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isSponsorMatchEnabled } from "@/lib/api/sponsor-match";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sponsor match — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function SponsorMatchPage() {
  if (!isSponsorMatchEnabled()) notFound();
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/sponsor-match");
  }
  // Superuser OR development role — the same verdict the data route reads.
  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "sponsor-match",
      path: "/edit/sponsor-match",
      reason: "not_developer_get",
    });
    return <ForbiddenEditPage />;
  }

  // Fold into the shared console — mirrors `/edit/find-researchers`.
  const superuserSurfaces = session.isSuperuser;
  const pendingSlugRequests =
    superuserSurfaces && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const administratorsTab = superuserSurfaces && isAdministratorsTabEnabled() ? 0 : null;

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="sponsor-match-page">
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
        active="sponsor-match"
        pendingSlugRequests={pendingSlugRequests}
        administratorsTab={administratorsTab}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
        viewerIsDeveloper={session.isDeveloper}
        superuserSurfaces={superuserSurfaces}
        profilesTab={session.isCommsSteward || session.isSuperuser}
        unitsTab={session.isCommsSteward || session.isSuperuser}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <SponsorMatchPanel />
      </main>
    </div>
  );
}
