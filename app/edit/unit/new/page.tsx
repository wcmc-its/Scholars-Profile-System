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
 */
import { redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { UnitCreateForm } from "@/components/edit/unit-create-form";
import type { DepartmentOption } from "@/components/edit/department-picker";
import { getEditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  canManageAccess,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";

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

  const session = await getEditSession();
  if (!session) {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (dept) qs.set("dept", dept);
    const ret = `/edit/unit/new${qs.toString() ? `?${qs.toString()}` : ""}`;
    redirect(`/api/auth/saml/login?return=${encodeURIComponent(ret)}`);
  }

  const mode: "center" | "division" = type === "division" ? "division" : "center";
  const isSuperuser = session.isSuperuser;

  function forbidden(reason: "not_superuser" | "not_curator") {
    logEditDenial({
      actorCwid: session!.cwid,
      targetCwid: dept ?? "new-unit",
      path: "/edit/unit/new",
      reason,
      targetEntityType: mode === "division" ? "division" : "center",
      targetEntityId: dept ?? "new",
    });
    return <ForbiddenEditPage variant="unit" targetEntity={dept ?? "a new unit"} />;
  }

  // --- division: Superuser only ---
  if (mode === "division") {
    if (!isSuperuser) return forbidden("not_superuser");
    const departments = await loadDepartments();
    return (
      <CreateChrome heading="Create a division" subtitle="Pre-register a coded division before the directory catches up.">
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
      <CreateChrome heading="Create a unit" subtitle="Create a center or institute, or pre-register a coded division.">
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
    <CreateChrome heading="Create a center" subtitle={`A new center or institute under ${parent.name}.`}>
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
  children,
}: {
  heading: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="unit-create-page">
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
        <h1 className="mb-1 text-xl font-semibold">{heading}</h1>
        <p className="text-muted-foreground mb-6 text-sm">{subtitle}</p>
        {children}
      </main>
    </div>
  );
}
