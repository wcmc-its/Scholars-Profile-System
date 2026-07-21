/**
 * `/edit/slug-requests` — the superuser Profile-URL approval queue (#497 PR-3c,
 * `slug-personalization-ui-spec.md` § 3). The admin surface where a Scholars
 * administrator approves or declines the slug requests scholars file from the
 * self editor's "Profile URL" card (PR-3b).
 *
 * Superuser-gated at B2 (re-checked here on every GET, never cached — the query,
 * not the UI, is the boundary) and flag-gated behind `SELF_EDIT_SLUG_REQUEST`
 * (off ⇒ 404, mirroring the endpoints). `force-dynamic` + `noindex`, like the
 * other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SlugRequestQueue } from "@/components/edit/slug-request-queue";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { isSlugRequestEnabled, loadSlugRequestQueue } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profile URL requests — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function SlugRequestsPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/slug-requests");
  }
  // Superuser re-check on every GET (B2). Emits the `edit_authz_denied` line.
  const denial = requireSuperuserGet({
    session,
    path: "/edit/slug-requests",
    targetId: "slug-requests",
  });
  if (denial !== null) {
    return <ForbiddenEditPage />;
  }
  // The queue surface doesn't exist until ops enable the feature.
  if (!isSlugRequestEnabled()) {
    notFound();
  }

  const requests = await loadSlugRequestQueue(db.read);
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;


  return (
    <ConsoleShell
      active="slug-requests"
      session={session}
      pendingSlugRequests={requests.length}
      pendingHonors={pendingHonors}
    >
      <h1 className="mb-1 text-xl font-semibold">Profile URL requests</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Pending scholar requests for a personalized URL, oldest first. Approving writes the override
        and redirects the old address.
      </p>
      <SlugRequestQueue initialRequests={requests} />
    </ConsoleShell>
  );
}
