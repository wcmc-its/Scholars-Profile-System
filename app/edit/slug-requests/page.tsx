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

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { SlugRequestQueue } from "@/components/edit/slug-request-queue";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { requireSuperuserGet } from "@/lib/edit/authz";
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

  // Back-link to the admin's own self-edit surface — only when they have a
  // (non-deleted) profile, so a staff superuser without one never gets a 404.
  const self = await db.read.scholar.findUnique({
    where: { cwid: session.cwid },
    select: { deletedAt: true },
  });
  const selfEditHref = self && self.deletedAt === null ? "/edit" : null;

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="slug-requests-page">
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
        active="slug-requests"
        pendingSlugRequests={requests.length}
        administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
        selfEditHref={selfEditHref}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">Profile URL requests</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Pending scholar requests for a personalized URL, oldest first. Approving writes the
          override and redirects the old address.
        </p>
        <SlugRequestQueue initialRequests={requests} />
      </main>
    </div>
  );
}
