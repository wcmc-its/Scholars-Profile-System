/**
 * `/edit/core/[coreId]` — the core's own editor (cores-as-org-units P3/P4
 * restructure; Edit Org Unit mockup, Core variant, 2026-09-28): one scrolling
 * page of Basics, Leadership, Staff and (Owner/Superuser/comms_steward) Access
 * under a review-queue banner, rendered by `CoreEditSections` on the same
 * `UnitEditSections` shell the department/division/center editors use. A
 * legacy `?attr=details|leadership|access` link scrolls to its section. Built
 * as a bespoke page — NOT routed through `unit-edit-page.tsx`
 * (`UnitEditContext`/`findUnit`/`getEffectiveUnitRole` are hardcoded
 * department|division|center throughout and are production infrastructure the
 * three already-shipped unit types depend on; lower blast radius to build
 * cores' own page here than to widen that shared plumbing,
 * `core-as-org-unit-plan.md` P3).
 *
 * The pub review queue (`CoreClaimQueue`) moved to its own route,
 * `/edit/core/[coreId]/review` — a sibling sub-page, not a rail attribute
 * (mirrors `/edit/center/[code]/history`, a bespoke child route reusing the
 * parent's own authz gate rather than sharing this page).
 *
 * Server Component. Authorization mirrors the unit-curation editor routes
 * (`/edit/center/[code]`):
 *   1. **No session** → SAML-login redirect carrying this URL.
 *   2. **Effective core role** (Superuser / comms_steward / owner / curator of
 *      this core, i.e. `UnitAdmin(entityType="core", entityId=coreId)`) →
 *      render. A comms_steward passes regardless of any personal `UnitAdmin`
 *      row (`authorizeCoreClaim`, 2026-08-26 policy widening decision #6).
 *   3. **No role + core exists** → one `edit_authz_denied` line + a visible 403;
 *      **core absent** → 404.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { CoreEditSections } from "@/components/edit/core-edit-sections";
import type { CoreLeaderState } from "@/components/edit/core-leader-card";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { countHighConfidence, countReviewSuggestions } from "@/lib/api/core-console-index";
import { loadCoreReviewQueue } from "@/lib/api/core-queue";
import { corePath } from "@/lib/core-url";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  authorizeCoreClaim,
  canManageAccess as canManageAccessPredicate,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { loadConsoleTabs } from "@/lib/edit/console-tabs.server";
import { isCorePagesEnabled, isCorePubModalEnabled } from "@/lib/profile/cores-flags";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit core",
  robots: { index: false, follow: false },
};

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

  // Access (Owner/Superuser/comms_steward — "Curators grant nothing", but a
  // steward is full access-management parity regardless of their own core
  // role, 2026-08-26 policy widening decision #3), delegated to `lib/edit/
  // authz`'s own `canManageAccess` predicate — `coreRole` is already the
  // `EffectiveUnitRole` it expects, so this is the same check
  // `unit-edit-context.ts`'s local now also delegates to.
  const canManageAccess = canManageAccessPredicate(session, coreRole).ok;
  const [core, leaderRows, coreRoleRows, accessRows, queue, consoleTabs] = await Promise.all([
    db.read.core.findUnique({
      where: { id: coreId },
      select: {
        name: true,
        description: true,
        url: true,
        visible: true,
        staffCount: true,
        staffTrackedCount: true,
      },
    }),
    db.read.coreLeader.findMany({
      where: { coreId },
      orderBy: [{ sortOrder: "asc" }, { cwid: "asc" }],
      select: { cwid: true, role: true, interim: true, sortOrder: true },
    }),
    // #2559 — the `core` slice of the role vocabulary, so `CoreLeaderCard`
    // (a Client Component) can resolve each leader's stored key to its
    // CURRENT label without importing `@/lib/db` itself.
    db.read.orgUnitRole.findMany({
      where: { entityType: "core" },
      select: { key: true, label: true },
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
    // Drives the "Cores" breadcrumb link — the same cores-tab predicate the
    // `/edit/core` index's nav entry gates on, not a bespoke check.
    loadConsoleTabs(session, db.read),
  ]);
  if (!core) notFound();
  const candidates = queue?.candidates ?? [];

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

  const roleLabels = Object.fromEntries(coreRoleRows.map((r) => [r.key, r.label]));

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

  // The header note's role, by `unit-edit-context.ts`'s own rule: a
  // comms_steward with no grant of their own edits at curator parity.
  const actorRole = session.isSuperuser ? "superuser" : coreRole === "none" ? "curator" : coreRole;
  // The public page 404s with CORE_PAGES off, and a hidden core isn't listed —
  // only offer a preview when it would really show (both public flags + visible).
  const previewHref =
    core.visible && isCorePagesEnabled() && isCorePubModalEnabled() ? corePath(coreId) : undefined;
  const { attr } = (await searchParams) ?? {};

  return (
    <CoreEditSections
      core={{ id: coreId, ...core }}
      leaders={leaders}
      roleLabels={roleLabels}
      access={access}
      accessReadOnly={session.isContentEditor === true}
      actorCwid={session.cwid}
      actorRole={actorRole}
      pending={{
        // The /edit/core index's own "To review" count (display floor applied).
        total: countReviewSuggestions(candidates, coreId),
        strong: countHighConfidence(candidates),
      }}
      previewHref={previewHref}
      coresNavVisible={consoleTabs.cores}
      attr={attr}
    />
  );
}
