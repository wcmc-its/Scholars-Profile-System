/**
 * `/edit/core/[coreId]` — the core's own attribute editor (cores-as-org-units
 * P3/P4 restructure): Details, Leadership, and (Owner/Superuser only) Access,
 * one panel at a time via `?attr=`. Mirrors `/edit/center/[code]`'s
 * `EditShell`/`AttributeRail` UX exactly, but built as a bespoke page — NOT
 * routed through `unit-edit-page.tsx` (`UnitEditContext`/`findUnit`/
 * `getEffectiveUnitRole` are hardcoded department|division|center throughout
 * and are production infrastructure the three already-shipped unit types
 * depend on; lower blast radius to build cores' own rail here than to widen
 * that shared plumbing, `core-as-org-unit-plan.md` P3).
 *
 * The pub review queue (`CoreClaimQueue`) moved to its own route,
 * `/edit/core/[coreId]/review` — a sibling sub-page, not a rail attribute
 * (mirrors `/edit/center/[code]/history`, a bespoke child route reusing the
 * parent's own authz gate rather than sharing this page).
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
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";

import type { RailItem } from "@/components/edit/attribute-rail";
import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { CoreDetailsCard } from "@/components/edit/core-details-card";
import { CoreLeaderCard, type CoreLeaderState } from "@/components/edit/core-leader-card";
import { EditShell } from "@/components/edit/edit-shell";
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
  title: "Edit core",
  robots: { index: false, follow: false },
};

type AttrKey = "details" | "leadership" | "access";
const DEFAULT_ATTR: AttrKey = "details";

export default async function EditCorePage({
  params,
  searchParams,
}: {
  params: Promise<{ coreId: string }>;
  searchParams?: Promise<{ attr?: string }>;
}) {
  const { coreId } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/core/${encodeURIComponent(coreId)}`);
  }

  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    // Distinguish "no such core" (404) from "exists but you can't edit it" (403).
    const exists = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: coreId,
      path: `/edit/core/${coreId}`,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return (
      <div className="bg-apollo-page min-h-screen">
        <ConsoleTopBar variant="console" />
        <ForbiddenEditPage variant="unit" targetEntity={coreId} />
      </div>
    );
  }

  // Access (Owner/Superuser only — "Curators grant nothing") mirrors
  // `unit-edit-context.ts`'s own `canManageAccess` local, not the
  // `lib/edit/authz` predicate of the same name (that one gates
  // `/api/edit/unit`'s create-unit path, unrelated here).
  const canManageAccess = session.isSuperuser || coreRole === "owner";
  const [core, leaderRows, accessRows, queue] = await Promise.all([
    db.read.core.findUnique({
      where: { id: coreId },
      select: { name: true, description: true, url: true, visible: true },
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
    // Reuses the review page's own loader for the pending count — the same
    // query the review page runs, not a hand-rolled parallel count that could
    // drift from its candidate/confirmed/rejected partition logic.
    loadCoreReviewQueue(coreId, db.read),
  ]);
  if (!core) notFound();
  const pendingCount = queue?.candidates.length ?? 0;

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

  const railItems: RailItem[] = [
    { key: "details", label: "Details" },
    { key: "leadership", label: "Leadership" },
    ...(canManageAccess ? [{ key: "access", label: "Access" }] : []),
  ];
  const { attr } = (await searchParams) ?? {};
  const active = (railItems.some((r) => r.key === attr) ? attr : DEFAULT_ATTR) as AttrKey;
  const basePath = `/edit/core/${coreId}`;

  return (
    <EditShell
      mode="superuser"
      scholarName={core.name}
      // A unit, not a scholar profile — "Profiles" never has anywhere useful
      // to go from a unit editor.
      isProfileEntity={false}
      railItems={railItems}
      activeAttr={active}
      basePath={basePath}
    >
      {/* The core owner's PRIMARY task — reviewing candidate publications —
          lives on a separate route (see file header), so it needs a real
          call-to-action here, not a small text link a scanning admin can
          miss. The amber dot follows R13 (Apollo Surface Language): amber
          means "awaiting human judgment," hoisted to this one indicator
          rather than repeated per-row. */}
      <Link
        href={`${basePath}/review`}
        className="border-apollo-border bg-apollo-surface hover:border-apollo-slate-tint-border mb-6 flex items-center justify-between gap-4 rounded-lg border px-5 py-4 transition-colors hover:no-underline"
        data-testid="core-review-link"
      >
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <span className="bg-apollo-amber size-2.5 flex-none rounded-full" aria-hidden />
          )}
          <div>
            <div className="font-medium">Review pending publications</div>
            <div className="text-muted-foreground text-sm">
              {pendingCount > 0
                ? `${pendingCount} publication${pendingCount === 1 ? "" : "s"} awaiting your review`
                : "No publications pending review"}
            </div>
          </div>
        </div>
        <ArrowRight className="text-muted-foreground size-4 flex-none" aria-hidden />
      </Link>
      {active === "details" && (
        <CoreDetailsCard
          coreId={coreId}
          description={core.description}
          url={core.url}
          visible={core.visible}
        />
      )}
      {active === "leadership" && <CoreLeaderCard coreId={coreId} leaders={leaders} />}
      {active === "access" && canManageAccess && (
        <UnitAccessCard
          entityType="core"
          entityId={coreId}
          access={access}
          actorCwid={session.cwid}
          headingId="core-access-heading"
        />
      )}
    </EditShell>
  );
}
