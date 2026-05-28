/**
 * `/edit/department/[code]` — the department curator surface (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § Page-level authorization). The first of the
 * unit-curation editor routes; PR-7b/7c add center + division.
 *
 * Server Component. Three authorization gates run in order (mirroring
 * `/edit/scholar/[cwid]`):
 *
 *   1. **No session** → SAML-login redirect with `?return=` carrying this URL.
 *   2. **Effective role** on the department (Superuser / Owner / Curator) →
 *      render. `loadUnitEditContext` returns `null` when the actor has no role
 *      (and isn't a Superuser), or when the unit is retired and the actor isn't
 *      a Superuser.
 *   3. **No context + unit exists** → emit one `edit_authz_denied` line and
 *      render the visible 403. **No context + unit absent** → 404.
 *
 * Reads suppression-OFF (via `loadUnitEditContext`); the role gate above is what
 * closes the data-exposure window when a user loses access mid-session.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { UnitEditPage } from "@/components/edit/unit-edit-page";
import { loadUnitEditContext } from "@/lib/api/unit-edit-context";
import { getEditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit department",
  robots: { index: false, follow: false },
};

export default async function EditDepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams?: Promise<{ attr?: string }>;
}) {
  const { code } = await params;

  const session = await getEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/department/${encodeURIComponent(code)}`);
  }

  const ctx = await loadUnitEditContext("department", code, session, db.read);
  if (ctx === null) {
    // Distinguish "no such department" (404) from "exists but you can't edit it"
    // (visible 403 + a logged denial).
    const exists = await db.read.department.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: `/edit/department/${code}`,
      reason: "not_curator",
      targetEntityType: "department",
      targetEntityId: code,
    });
    return <ForbiddenEditPage variant="unit" targetEntity={code} />;
  }

  const { attr } = (await searchParams) ?? {};
  return <UnitEditPage ctx={ctx} attr={attr} />;
}
