/**
 * `/edit/center/[code]` — the center curator surface (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § Page-level authorization). The second of the
 * unit-curation editor routes (PR-7b); a sibling of `/edit/department/[code]`.
 *
 * Server Component. Three authorization gates run in order (mirroring the
 * department route):
 *
 *   1. **No session** → SAML-login redirect with `?return=` carrying this URL.
 *   2. **Effective role** on the center (Superuser / Owner / Curator) → render.
 *      `loadUnitEditContext` returns `null` when the actor has no role (and isn't
 *      a Superuser), or when the center is retired and the actor isn't a
 *      Superuser.
 *   3. **No context + center exists** → emit one `edit_authz_denied` line and
 *      render the visible 403. **No context + center absent** → 404.
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
  title: "Edit center",
  robots: { index: false, follow: false },
};

export default async function EditCenterPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams?: Promise<{ attr?: string }>;
}) {
  const { code } = await params;

  const session = await getEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/center/${encodeURIComponent(code)}`);
  }

  const ctx = await loadUnitEditContext("center", code, session, db.read);
  if (ctx === null) {
    // Distinguish "no such center" (404) from "exists but you can't edit it"
    // (visible 403 + a logged denial).
    const exists = await db.read.center.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: `/edit/center/${code}`,
      reason: "not_curator",
      targetEntityType: "center",
      targetEntityId: code,
    });
    return <ForbiddenEditPage variant="unit" targetEntity={code} />;
  }

  const { attr } = (await searchParams) ?? {};
  return <UnitEditPage ctx={ctx} attr={attr} />;
}
