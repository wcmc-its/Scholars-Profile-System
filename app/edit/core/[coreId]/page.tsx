/**
 * `/edit/core/[coreId]` — the core owner's review queue (cores inference), plus
 * (cores-as-org-units P3) the core's own attribute editors: description, URL,
 * visibility, leadership, and access. Lists the engine's candidate
 * (publication, core) usages for one core, ranked by likelihood, with inline
 * evidence; the owner confirms/rejects each via `POST /api/edit/core-claim`.
 *
 * Server Component. Authorization mirrors the unit-curation editor routes
 * (`/edit/center/[code]`):
 *   1. **No session** → SAML-login redirect carrying this URL.
 *   2. **Effective core role** (Superuser / owner / curator of this core, i.e.
 *      `UnitAdmin(entityType="core", entityId=coreId)`) → render.
 *   3. **No role + core exists** → one `edit_authz_denied` line + a visible 403;
 *      **core absent** → 404.
 *
 * P3's new panels (`CoreDetailsCard`, `CoreLeaderCard`, `UnitAccessCard`) are
 * a bespoke, flat stack alongside `CoreClaimQueue` — NOT the shared
 * `EditShell`/`AttributeRail` pattern `/edit/{department,division,center}`
 * use (`unit-edit-page.tsx`), which is hardcoded to those three unit kinds
 * throughout (`UnitEditContext`, `findUnit`, `getEffectiveUnitRole`) and is
 * production infrastructure three already-shipped unit types depend on —
 * lower blast radius to add core-specific panels here than to widen it
 * (`core-as-org-unit-plan.md` P3). Every viewer who reaches this page already
 * cleared the owner/curator/superuser gate above, so the panels below need no
 * further per-panel visibility check except Access, which — like the rail's
 * own `isOwnerPlus` gate — is Owner/Superuser only.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { CoreClaimQueue } from "@/components/edit/core-claim-queue";
import { CoreDetailsCard } from "@/components/edit/core-details-card";
import { CoreLeaderCard, type CoreLeaderState } from "@/components/edit/core-leader-card";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { UnitAccessCard } from "@/components/edit/unit-access-card";
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

  // P3 panels' data. `loadCoreReviewQueue` above already proved the core
  // exists, so `coreDetail` is never null here. Access (Owner/Superuser only —
  // "Curators grant nothing") mirrors `unit-edit-context.ts`'s own
  // `canManageAccess` local, not the `lib/edit/authz` predicate of the same
  // name (that one gates `/api/edit/unit`'s create-unit path, unrelated here).
  const canManageAccess = session.isSuperuser || coreRole === "owner";
  const [coreDetail, leaderRows, accessRows] = await Promise.all([
    db.read.core.findUnique({
      where: { id: coreId },
      select: { description: true, url: true, visible: true },
    }),
    db.read.coreLeader.findMany({
      where: { coreId },
      orderBy: [{ sortOrder: "asc" }, { cwid: "asc" }],
      select: { cwid: true, role: true, interim: true, sortOrder: true },
    }),
    canManageAccess
      ? db.read.unitAdmin.findMany({
          where: { entityType: "core", entityId: coreId },
          select: { cwid: true, role: true, source: true, grantedBy: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // Batch-resolve leader + access cwids to display names (a unit admin is
  // often non-Scholar staff, so a miss is expected — UnitAccessCard
  // re-resolves those names client-side via /api/directory/people).
  const nameCwids = [...new Set([...leaderRows.map((l) => l.cwid), ...accessRows.map((a) => a.cwid)])];
  const scholars = nameCwids.length
    ? await db.read.scholar.findMany({
        where: { cwid: { in: nameCwids } },
        select: { cwid: true, preferredName: true, primaryTitle: true },
      })
    : [];
  const nameMap = new Map(scholars.map((s) => [s.cwid, { name: s.preferredName, title: s.primaryTitle }]));

  const leaders: CoreLeaderState[] = leaderRows.map((l) => ({
    cwid: l.cwid,
    name: nameMap.get(l.cwid)?.name ?? null,
    title: nameMap.get(l.cwid)?.title ?? null,
    role: l.role,
    interim: l.interim,
    sortOrder: l.sortOrder,
  }));

  const access = canManageAccess
    ? accessRows.map((a) => ({
        cwid: a.cwid,
        name: nameMap.get(a.cwid)?.name ?? a.cwid,
        title: nameMap.get(a.cwid)?.title ?? null,
        role: a.role,
        source: a.source,
        grantedBy: a.grantedBy,
        grantedAt: a.createdAt,
      }))
    : null;

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="edit-core-page">
      <ConsoleTopBar variant="console" />

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

        <div className="mt-10 flex flex-col gap-8">
          <CoreDetailsCard
            coreId={coreId}
            description={coreDetail?.description ?? null}
            url={coreDetail?.url ?? null}
            visible={coreDetail?.visible ?? false}
          />
          <CoreLeaderCard coreId={coreId} leaders={leaders} />
          <UnitAccessCard
            entityType="core"
            entityId={coreId}
            access={access}
            actorCwid={session.cwid}
            headingId="core-access-heading"
          />
        </div>
      </main>
    </div>
  );
}
