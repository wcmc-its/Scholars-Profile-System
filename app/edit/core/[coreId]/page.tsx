/**
 * `/edit/core/[coreId]` — the core owner's review queue (cores inference). Lists
 * the engine's candidate (publication, core) usages for one core, ranked by
 * likelihood, with inline evidence; the owner confirms/rejects each via
 * `POST /api/edit/core-claim`.
 *
 * Server Component. Authorization mirrors the unit-curation editor routes
 * (`/edit/center/[code]`):
 *   1. **No session** → SAML-login redirect carrying this URL.
 *   2. **Effective core role** (Superuser / owner / curator of this core, i.e.
 *      `UnitAdmin(entityType="core", entityId=coreId)`) → render.
 *   3. **No role + core exists** → one `edit_authz_denied` line + a visible 403;
 *      **core absent** → 404.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { CoreClaimQueue } from "@/components/edit/core-claim-queue";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { loadCoreReviewQueue } from "@/lib/api/core-queue";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Review core publications",
  robots: { index: false, follow: false },
};

export default async function EditCorePage({
  params,
}: {
  params: Promise<{ coreId: string }>;
}) {
  const { coreId } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/core/${encodeURIComponent(coreId)}`);
  }

  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    // Distinguish "no such core" (404) from "exists but you can't review it" (403).
    const exists = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: coreId,
      path: `/edit/core/${coreId}`,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return <ForbiddenEditPage />;
  }

  const queue = await loadCoreReviewQueue(coreId, db.read);
  if (!queue) notFound();

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="edit-core-page">
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

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <h1 className="mb-1 text-xl font-semibold">{queue.core.name} — core publications</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Publications our signals flag as having used this core. Confirm the ones that did and
          reject false positives — your decisions surface on the public profiles and prime the next
          inference run.
        </p>
        <CoreClaimQueue
          core={queue.core}
          candidates={queue.candidates}
          confirmed={queue.confirmed}
          rejected={queue.rejected}
        />
      </main>
    </div>
  );
}
