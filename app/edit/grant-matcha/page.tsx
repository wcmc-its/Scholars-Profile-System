/**
 * `/edit/grant-matcha` — Grant Matcha (convergence plan 2026-07-22): pick a funding
 * opportunity and rank WCM researchers on its text through the Matcha spine (extractor →
 * per-concept OpenSearch fan-out → RRF fuse). Same surface as `/edit/matcha`, but the ask is
 * SEEDED from an opportunity's title + synopsis instead of a pasted sponsor description.
 *
 * Dark page (PR1): reachable by URL only while `GRANT_MATCHA` is on — no console nav tab yet
 * (a later PR surfaces it). Gate mirrors `/edit/matcha` (superuser OR development role) AND adds
 * `isGrantMatchaEnabled()`; `notFound()` while either flag is off so the dark surface is never
 * revealed. The data route (`/api/edit/matcha`) is the real authorization boundary and re-checks.
 * `force-dynamic` + `noindex`, mirroring the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { GrantMatchaPanel } from "@/components/edit/grant-matcha-panel";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isGrantMatchaEnabled } from "@/lib/edit/grant-recs";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Grant Matcha — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function GrantMatchaPage() {
  // GRANT_MATCHA depends on MATCHA (the Matcha spine + `/api/edit/matcha` are what this seeds).
  if (!isMatchaEnabled() || !isGrantMatchaEnabled()) notFound();
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/grant-matcha");
  }
  // Superuser OR development role — the same verdict the data route reads.
  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "grant-matcha",
      path: "/edit/grant-matcha",
      reason: "not_developer_get",
    });
    return <ForbiddenEditPage />;
  }

  // Fold into the shared console — mirrors `/edit/matcha`.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    // ponytail: reuse `active="matcha"` — this dark page has no nav tab of its own yet (a later PR
    // adds one to `admin-subnav.tsx`). Grant Matcha IS Matcha, so highlighting Matcha is honest.
    <ConsoleShell
      active="matcha"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <GrantMatchaPanel />
    </ConsoleShell>
  );
}
