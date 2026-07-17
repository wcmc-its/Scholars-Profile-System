/**
 * `/edit/core` — the cores review-queue index. Lists every core facility, each
 * linking to its owner review queue (`/edit/core/[coreId]`). Reached from the
 * "Cores" tab in the admin sub-nav.
 *
 * Audience: superuser-only for now — the admin-toolbar tab is the entry point and
 * is itself superuser-gated. A non-superuser core owner/curator still reaches
 * THEIR queue via the per-core deep link (`/edit/core/[coreId]`, auth-gated on
 * `getCoreOwnerRole`); an owner-scoped index is a future add (the account-menu
 * entry point). `force-dynamic` + `noindex`, mirroring the rest of `/edit/*`.
 */
import { redirect } from "next/navigation";
import Link from "next/link";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getCoreList } from "@/lib/api/cores";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cores — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function EditCoresIndexPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/core");
  }
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "core",
      path: "/edit/core",
      reason: "not_superuser_get",
    });
    return <ForbiddenEditPage />;
  }

  const cores = await getCoreList(db.read);

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
    <div className="min-h-screen bg-[var(--background)]" data-slot="edit-cores-index">
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
        active="cores"
        unitsTab={session.isSuperuser}
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
        administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">Core facilities</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Review the engine-suggested publications for each core facility. Confirmed publications
          appear on the public core page; rejected ones are hidden. A core with no staff feed yet
          has nothing to review.
        </p>
        <ul className="divide-border divide-y rounded-md border" data-testid="edit-cores-list">
          {cores.map((c) => (
            <li key={c.id}>
              <Link
                href={`/edit/core/${encodeURIComponent(c.id)}`}
                className="hover:bg-muted/50 flex items-center justify-between gap-3 px-4 py-3"
              >
                <span>
                  <span className="font-medium">{c.name}</span>
                  {c.facility && c.facility !== c.name ? (
                    <span className="text-muted-foreground block text-sm">{c.facility}</span>
                  ) : null}
                </span>
                <span className="text-muted-foreground shrink-0 text-sm" aria-hidden>
                  Review →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
