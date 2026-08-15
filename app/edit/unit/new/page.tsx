/**
 * `/edit/unit/new` — the manual-unit create form (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § The create form). One route, two modes
 * selected by `?type=center|division`:
 *
 *   - **center** (`?type=center`, the default) — an Owner of the `?dept=`
 *     department, or a Superuser, creates an informal center/institute.
 *   - **division** (`?type=division`) — a Superuser pre-registers a coded LDAP
 *     division.
 *
 * Page-level authorization (an unauthorized GET renders the same visible 403 as
 * the rest of `/edit/*`):
 *   - division → Superuser only.
 *   - center → Superuser, or Owner of the named parent department (the create
 *     endpoint's `canManageAccess` check, mirrored here so the form never
 *     renders for someone who can't submit it).
 *
 * A Superuser sees the mode toggle and a department picker (the full list is
 * loaded here — a small bounded set — so the client filters in-memory with no
 * extra endpoint). An Owner sees the center form only, with the parent
 * department fixed read-only from `?dept=`.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 *
 * 2026-08-15: `CreateChrome` used to be a bare `ConsoleTopBar` + page background
 * (bar, no nav) — Tier C decision 3 (`docs/audits/apollo-v2-surface-audit-2026-08-14.md`
 * §4b, C11) judged that a deliberate omission, not this page's case: unlike
 * `core/[coreId]/review`'s documented reduced-chrome, every viewer who reaches
 * this form has already cleared this page's own unit-admin gate (Owner or
 * Superuser), so they're squarely inside the Units console area, not a
 * pre-selection chooser — they should get the real nav, same as every other
 * `/edit/units*` surface. `CreateChrome` now renders the full `ConsoleShell`
 * (`active="units"`), and the denial branch (`forbidden()`) is wrapped in the
 * SAME shell rather than left bare (the Tier C decision 2 fix, applied here
 * alongside decision 3 since both touch this file).
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { RequestNewOrgUnitDialog } from "@/components/edit/request-new-org-unit-dialog";
import { UnitCreateForm } from "@/components/edit/unit-create-form";
import type { DepartmentOption } from "@/components/edit/department-picker";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  canManageAccess,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { isOrgUnitCreateSuperuserOnly } from "@/lib/edit/unit-create-flags";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Create a unit — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function NewUnitPage({
  searchParams,
}: {
  searchParams?: Promise<{ type?: string; dept?: string }>;
}) {
  const { type, dept } = (await searchParams) ?? {};

  const session = await getEffectiveEditSession();
  if (!session) {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (dept) qs.set("dept", dept);
    const ret = `/edit/unit/new${qs.toString() ? `?${qs.toString()}` : ""}`;
    redirect(`/api/auth/saml/login?return=${encodeURIComponent(ret)}`);
  }

  const mode: "center" | "division" = type === "division" ? "division" : "center";
  const isSuperuser = session.isSuperuser;

  // Mirrors the sibling console pages (e.g. app/edit/core/page.tsx): `null`
  // hides the tab/badge (flag off, or this viewer isn't superuser/honors_curator).
  // Computed unconditionally, including on paths that end up denied below — the
  // two reads are cheap and every denial still renders through the same shell,
  // which needs a real value either way.
  const pendingSlugRequests = isSlugRequestEnabled()
    ? await countPendingSlugRequests(db.read)
    : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  function forbidden(reason: "not_superuser" | "not_curator") {
    logEditDenial({
      actorCwid: session!.cwid,
      targetCwid: dept ?? "new-unit",
      path: "/edit/unit/new",
      reason,
      targetEntityType: mode === "division" ? "division" : "center",
      targetEntityId: dept ?? "new",
    });
    return (
      <ConsoleShell
        active="units"
        session={session!}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage variant="unit" targetEntity={dept ?? "a new unit"} />
      </ConsoleShell>
    );
  }

  // --- division: Superuser only ---
  if (mode === "division") {
    if (!isSuperuser) return forbidden("not_superuser");
    const departments = await loadDepartments();
    return (
      <CreateChrome
        heading="Create a division"
        subtitle="Pre-register a coded division before the directory catches up."
        session={session}
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
      >
        <UnitCreateForm
          initialMode="division"
          canSwitchMode
          isSuperuser
          departments={departments}
          fixedDept={null}
        />
      </CreateChrome>
    );
  }

  // --- center: Superuser, or Owner of the named parent department ---
  if (isSuperuser) {
    const departments = await loadDepartments();
    return (
      <CreateChrome
        heading="Create a unit"
        subtitle="Create a center or institute, or pre-register a coded division."
        session={session}
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
      >
        <UnitCreateForm
          initialMode="center"
          canSwitchMode
          isSuperuser
          departments={departments}
          fixedDept={null}
        />
      </CreateChrome>
    );
  }

  // #728 Phase D § 4.5: with the lockdown on, org-unit creation is
  // superuser-only. A non-superuser sees the "Request a new org unit" affordance
  // (§ 4.6) instead of the Owner center form — the create endpoint now refuses
  // the same submission, so rendering the form would be a dead end.
  if (isOrgUnitCreateSuperuserOnly()) {
    return (
      <CreateChrome
        heading="Request a new org unit"
        subtitle="New org units are created by Scholars superusers. Send a request and we'll route it."
        session={session}
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
      >
        <RequestNewOrgUnitDialog />
      </CreateChrome>
    );
  }

  // Non-Superuser: must be an Owner of the named department.
  if (typeof dept !== "string" || dept.length === 0) {
    return forbidden("not_curator");
  }
  const parent = await db.read.department.findUnique({
    where: { code: dept },
    select: { code: true, name: true },
  });
  if (!parent) return forbidden("not_curator");

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "department", code: dept },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canManageAccess(session, effective);
  if (!authz.ok) return forbidden("not_curator");

  return (
    <CreateChrome
      heading="Create a center"
      subtitle={`A new center or institute under ${parent.name}.`}
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <UnitCreateForm
        initialMode="center"
        canSwitchMode={false}
        isSuperuser={false}
        departments={[]}
        fixedDept={{ code: parent.code, name: parent.name }}
      />
    </CreateChrome>
  );
}

async function loadDepartments(): Promise<DepartmentOption[]> {
  const rows = await db.read.department.findMany({
    select: { code: true, name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({ code: r.code, name: r.name }));
}

function CreateChrome({
  heading,
  subtitle,
  session,
  pendingSlugRequests,
  pendingHonors,
  children,
}: {
  heading: string;
  subtitle: string;
  session: EditSession;
  pendingSlugRequests: number | null;
  pendingHonors: number | null;
  children: React.ReactNode;
}) {
  return (
    <ConsoleShell
      active="units"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <h1 className="mb-1 text-xl font-semibold">{heading}</h1>
      <p className="text-muted-foreground mb-6 text-sm">{subtitle}</p>
      {children}
    </ConsoleShell>
  );
}
