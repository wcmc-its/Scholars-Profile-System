/**
 * `/edit/core/[coreId]/review` — the core owner's pub review queue (cores
 * inference), split out of the core editor (cores-as-org-units P3/P4
 * restructure) into its own route, mirroring `/edit/center/[code]/history`: a
 * bespoke sub-page (its own `ConsoleTopBar`-based shell, NOT `EditShell`/
 * `AttributeRail`) reusing the SAME authz gate as the parent editor as its own
 * independent check — this route must be safely directly-linkable/bookmarkable
 * on its own, not dependent on the parent page having already run it.
 *
 * Lists the engine's candidate (publication, core) usages for one core, ranked
 * by likelihood, with inline evidence; the owner confirms/rejects each via
 * `POST /api/edit/core-claim`.
 *
 * Server Component. Authorization mirrors the core editor route:
 *   1. **No session** → SAML-login redirect carrying this URL.
 *   2. **Effective core role** (Superuser / owner / curator of this core, i.e.
 *      `UnitAdmin(entityType="core", entityId=coreId)`) → render.
 *   3. **No role + core exists** → one `edit_authz_denied` line + a visible 403;
 *      **core absent** → 404.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
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

export default async function EditCoreReviewPage({
  params,
}: {
  params: Promise<{ coreId: string }>;
}) {
  const { coreId } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/core/${encodeURIComponent(coreId)}/review`);
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
      path: `/edit/core/${coreId}/review`,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return <ForbiddenEditPage variant="unit" targetEntity={coreId} />;
  }

  const queue = await loadCoreReviewQueue(coreId, db.read);
  if (!queue) notFound();

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="edit-core-review-page">
      <ConsoleTopBar variant="console" />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <p className="mb-4">
          <Link
            href={`/edit/core/${encodeURIComponent(coreId)}`}
            className="text-apollo-slate hover:underline"
          >
            &larr; Back to {queue.core.name}
          </Link>
        </p>

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
