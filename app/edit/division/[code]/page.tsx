/**
 * `/edit/division/[code]` — the division curator surface (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § Page-level authorization). The third of the
 * unit-curation editor routes (PR-7c); a sibling of `/edit/department/[code]`
 * and `/edit/center/[code]`.
 *
 * Server Component. Three authorization gates run in order (mirroring the
 * department + center routes):
 *
 *   1. **No session** → SAML-login redirect with `?return=` carrying this URL.
 *   2. **Effective role** on the division (Superuser / Owner / Curator, with the
 *      dept→division cascade) → render. `loadUnitEditContext` returns `null`
 *      when the actor has no role (and isn't a Superuser), or when the division
 *      is retired and the actor isn't a Superuser.
 *   3. **No context + division exists** → emit one `edit_authz_denied` line and
 *      render the visible 403. **No context + division absent** → 404.
 *
 * A manual division (`source = 'manual'`) carries an editable roster; an
 * LDAP-sourced division does not (the `roster` rail row is filtered out). Both
 * edit description + leadership via `field_override` (the dept/div write path).
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { UnitEditPage } from "@/components/edit/unit-edit-page";
import { loadUnitEditContext } from "@/lib/api/unit-edit-context";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit division",
  robots: { index: false, follow: false },
};

export default async function EditDivisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams?: Promise<{ attr?: string }>;
}) {
  const { code } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/division/${encodeURIComponent(code)}`);
  }

  const ctx = await loadUnitEditContext("division", code, session, db.read);
  if (ctx === null) {
    // Distinguish "no such division" (404) from "exists but you can't edit it"
    // (visible 403 + a logged denial).
    const exists = await db.read.division.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: `/edit/division/${code}`,
      reason: "not_curator",
      targetEntityType: "division",
      targetEntityId: code,
    });
    return <ForbiddenEditPage variant="unit" targetEntity={code} />;
  }

  const { attr } = (await searchParams) ?? {};
  return <UnitEditPage ctx={ctx} attr={attr} />;
}
