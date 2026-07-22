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

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { MatchaPanel } from "@/components/edit/matcha-panel";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isGrantMatchaEnabled } from "@/lib/edit/grant-recs";
import { logEditDenial } from "@/lib/edit/authz";
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
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="matcha"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      {/* Grant Matcha (increment 3) — the people|grants target toggle appears only when
          GRANT_MATCHA is on. Same server-computed-boolean-prop pattern as
          `/edit/find-researchers`; the API route re-checks the flag as the real boundary. */}
      <MatchaPanel grantMatcha={isGrantMatchaEnabled()} />
    </ConsoleShell>
  );
}
