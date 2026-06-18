/**
 * `/edit/scholar/[cwid]/history` — the read-only scholar profile audit view
 * (#955 finding #11). A sub-route of the scholar editor (`/edit/scholar/[cwid]`)
 * and the sibling of `/edit/center/[code]/history`, surfacing the per-scholar
 * slice of the B03 audit log to anyone who may edit that scholar.
 *
 * Server Component. Authorization MIRRORS the editor route exactly — history
 * visibility == edit access. The same five gates run in the same order (self →
 * proxy → unit-admin → comms_steward / superuser), so a viewer who can reach
 * `/edit/scholar/[cwid]` can reach its history and no one else can:
 *
 *   1. **No session** → SAML-login redirect carrying this URL.
 *   2. **`session.cwid === cwid`** → self.
 *   3. **Granted, conflict-free proxy** (#779) → proxy.
 *   4. **Org-unit admin of a unit the scholar belongs to** (Amendment 4) → unit-admin.
 *   5. **comms_steward / superuser** → authorized; anyone else → a logged 403.
 *   Then **scholar absent / soft-deleted** → 404, and **#536 hidden identity
 *   class + non-superuser** → 404, both matching the editor.
 *
 * Keep this gate in sync with `app/edit/scholar/[cwid]/page.tsx` — extracting a
 * single shared resolver is a fast-follow tracked on #955. Only AFTER the gate
 * clears does the page read the audit history (`loadScholarAuditHistory`, scoped
 * to this cwid). The audit table is append-only; this surface never mutates it.
 *
 * No caching: `force-dynamic` + `noindex`, matching the rest of `/edit/*`.
 */
import { notFound, redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ScholarHistoryView } from "@/components/edit/scholar-history-view";
import { loadScholarAuditHistory, SCHOLAR_AUDIT_WINDOW_DAYS } from "@/lib/api/scholar-audit";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { requireSuperuserGet } from "@/lib/edit/authz";
import {
  checkProxyConflictingRole,
  isGrantedProxy,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";
import {
  resolveEditableUnitViaUnitAdmin,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profile change history",
  robots: { index: false, follow: false },
};

export default async function EditScholarHistoryPage({
  params,
}: {
  params: Promise<{ cwid: string }>;
}) {
  const { cwid: targetCwid } = await params;

  // Login gate keys on a real signed-in human, never the impersonation overlay
  // (mirrors the editor's RAW check).
  const raw = await getSession();
  if (!raw) {
    redirect(`/api/auth/saml/login?return=/edit/scholar/${encodeURIComponent(targetCwid)}/history`);
  }

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/scholar/${encodeURIComponent(targetCwid)}/history`);
  }

  const isSelf = session.cwid === targetCwid;

  // Granted, conflict-free proxy editor (#779). Keyed on the RAW identity and
  // only when NOT impersonating — a "View as" overlay must never confer it.
  let isProxy = false;
  if (!isSelf && !session.isSuperuser && raw.cwid === session.cwid) {
    if (await isGrantedProxy(raw.cwid, targetCwid, db.read as unknown as ProxyLookup)) {
      const conflict = await checkProxyConflictingRole(
        raw.cwid,
        db.read as unknown as ProxyLookup,
        async () => session.isSuperuser,
      );
      isProxy = conflict.ok;
    }
  }

  // Org-unit administrator of a unit the scholar belongs to (Amendment 4). Same
  // RAW-identity, not-impersonating, not-already-self/proxy conditions as the editor.
  let isUnitAdmin = false;
  if (!isSelf && !isProxy && !session.isSuperuser && raw.cwid === session.cwid) {
    const unit = await resolveEditableUnitViaUnitAdmin(
      raw.cwid,
      targetCwid,
      db.read as unknown as UnitScholarLookup,
    );
    isUnitAdmin = unit !== null;
  }

  // comms_steward / superuser / deny — the editor's final gate verbatim: a
  // steward is authorized; anyone else must be a superuser or gets a logged 403.
  if (!isSelf && !isProxy && !isUnitAdmin && !session.isCommsSteward) {
    const denial = requireSuperuserGet({
      session,
      path: `/edit/scholar/${targetCwid}/history`,
      targetId: targetCwid,
    });
    if (denial !== null) {
      return <ForbiddenEditPage targetCwid={targetCwid} />;
    }
  }

  // Scholar existence + the #536 hidden-class guard, mirroring the editor: an
  // absent or soft-deleted scholar 404s for everyone; a hidden identity class
  // (doctoral student) 404s for any non-superuser, including the scholar
  // themselves.
  const scholar = await db.read.scholar.findUnique({
    where: { cwid: targetCwid },
    select: { preferredName: true, roleCategory: true, deletedAt: true },
  });
  if (!scholar || scholar.deletedAt !== null) {
    notFound();
  }
  if (!session.isSuperuser && !isPubliclyDisplayed(scholar.roleCategory)) {
    notFound();
  }

  const entries = await loadScholarAuditHistory(targetCwid, db.read);

  return (
    <ScholarHistoryView
      cwid={targetCwid}
      scholarName={scholar.preferredName}
      entries={entries}
      windowDays={SCHOLAR_AUDIT_WINDOW_DAYS}
    />
  );
}
