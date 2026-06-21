/**
 * `/edit/center/[code]/history` — the read-only center roster audit view (#552
 * Phase 7; `center-management-spec.md` § 6.3). A sub-route of the center editor
 * (`/edit/center/[code]`); a sibling page that surfaces the per-center slice of
 * the B03 audit log to the unit's Owner / Curator / Superuser.
 *
 * Server Component. The SAME three authorization gates as the center editor run
 * in order (`loadUnitEditContext` is the single source of truth — a curator who
 * can edit can see the history, and no one else can):
 *
 *   1. **No session** → SAML-login redirect with `?return=` carrying this URL.
 *   2. **Effective role** on the center (Superuser / Owner / Curator) → render.
 *      `loadUnitEditContext` returns `null` when the actor has no role (and isn't
 *      a Superuser), or when the center is retired and the actor isn't a
 *      Superuser.
 *   3. **No context + center exists** → emit one `edit_authz_denied` line and
 *      render the visible 403. **No context + center absent** → 404.
 *
 * Only AFTER the gate is cleared does the page read the audit history
 * (`loadCenterAuditHistory`, scoped to this center's code). The audit table is
 * append-only and this surface never mutates it.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { CenterHistoryView } from "@/components/edit/center-history-view";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { CENTER_AUDIT_WINDOW_DAYS, loadCenterAuditHistory } from "@/lib/api/center-audit";
import { loadUnitEditContext } from "@/lib/api/unit-edit-context";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Center roster history",
  robots: { index: false, follow: false },
};

export default async function EditCenterHistoryPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/center/${encodeURIComponent(code)}/history`);
  }

  const ctx = await loadUnitEditContext("center", code, session, db.read);
  if (ctx === null) {
    // Distinguish "no such center" (404) from "exists but you can't see it"
    // (visible 403 + a logged denial) — mirrors the editor route exactly.
    const exists = await db.read.center.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!exists) notFound();
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: code,
      path: `/edit/center/${code}/history`,
      reason: "not_curator",
      targetEntityType: "center",
      targetEntityId: code,
    });
    return <ForbiddenEditPage variant="unit" targetEntity={code} />;
  }

  // The audit log lives in the separate `scholars_audit` database; the read role
  // (`db.read` / `app_ro`) needs a SELECT grant on `manual_edit_audit` there.
  // Until that grant is provisioned (a DBA step), the SELECT is denied (errno
  // 1142). Fail SOFT: render an "unavailable" notice instead of 500ing.
  let entries: Awaited<ReturnType<typeof loadCenterAuditHistory>> = [];
  let unavailable = false;
  try {
    entries = await loadCenterAuditHistory(code, db.read);
  } catch (err) {
    unavailable = true;
    console.error(
      JSON.stringify({
        event: "center_history_read_failed",
        path: "/edit/center/[code]/history",
        code,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return (
    <CenterHistoryView
      centerCode={ctx.unit.code}
      centerName={ctx.unit.name}
      entries={entries}
      windowDays={CENTER_AUDIT_WINDOW_DAYS}
      unavailable={unavailable}
    />
  );
}
