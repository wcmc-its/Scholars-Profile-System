/**
 * Shared authorization for WRITING a scholar's `overview` (bio) — the single
 * predicate behind BOTH the overview write (`POST /api/edit/field`) and the
 * overview generator (`POST /api/edit/overview/generate`). #844 widened the bio
 * to admins; extracting this one rule is the #844 follow-up ("no special rules"):
 * the generator authorizes EXACTLY whoever may write the bio, so the two surfaces
 * cannot drift.
 *
 * The layered rule, in order, short-circuiting on the first allow:
 *   1. self OR superuser             — `authorizeFieldEdit(overview)`
 *   2. granted proxy (#779)          — `isGrantedProxy` + fail-closed conflict re-check
 *   3. org-unit owner/curator (#728) — `resolveEditableUnitViaUnitAdmin`
 *
 * Legs 2 and 3 run ONLY for a non-impersonating request (`impersonatedCwid ===
 * null`), and are keyed on `realCwid` (NEVER the effective `session.cwid`): a
 * proxy / unit-admin is its own identity, and the `impersonatedCwid === null`
 * gate stops a #637 overlay from riding a delegated grant (IS-1). A granted proxy
 * that fails the conflict re-check is a hard `proxy_conflict` deny — it does NOT
 * fall through to the unit-admin leg (matches the field route's original flow).
 *
 * Returns `viaUnitAdminUnit` on a unit-admin allow so the caller can attribute
 * the edit in its B03 audit row. Pure of side effects (no logging) — each caller
 * logs its own `edit_authz_denied` at its own site, preserving its log shape.
 */
import type { EditSession } from "@/lib/auth/superuser";
import { authorizeFieldEdit } from "@/lib/edit/authz";
import {
  checkProxyConflictingRole,
  isGrantedProxy,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";
import {
  resolveEditableUnitViaUnitAdmin,
  type EditableUnit,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";

export type OverviewWriteAuthz =
  | { ok: true; viaUnitAdminUnit: EditableUnit | null }
  | { ok: false; reason: "not_self" | "proxy_conflict" };

export async function authorizeOverviewWrite(args: {
  session: EditSession;
  realCwid: string;
  impersonatedCwid: string | null;
  entityId: string;
  proxyDb: ProxyLookup;
  unitDb: UnitScholarLookup;
}): Promise<OverviewWriteAuthz> {
  const { session, realCwid, impersonatedCwid, entityId, proxyDb, unitDb } = args;

  // Leg 1 — self OR superuser. `authorizeFieldEdit(overview)` denies with
  // `not_self`; that is the base reason carried through if every leg fails.
  if (authorizeFieldEdit(session, { entityId, fieldName: "overview" }).ok) {
    return { ok: true, viaUnitAdminUnit: null };
  }

  // Delegated legs are for a non-impersonating actor only (IS-1).
  if (impersonatedCwid !== null) return { ok: false, reason: "not_self" };

  // Leg 2 — scholar-assigned proxy (#779). The fail-closed D3/D4 conflict re-check
  // runs on the proxy's OWN cwid (= realCwid when not impersonating).
  if (await isGrantedProxy(realCwid, entityId, proxyDb)) {
    const conflict = await checkProxyConflictingRole(realCwid, proxyDb);
    return conflict.ok
      ? { ok: true, viaUnitAdminUnit: null }
      : { ok: false, reason: "proxy_conflict" };
  }

  // Leg 3 — org-unit owner/curator (#728 / Amendment 4). The resolver re-reads
  // `unit_admin` every call, so a lost role takes effect on the next request.
  const unit = await resolveEditableUnitViaUnitAdmin(realCwid, entityId, unitDb);
  if (unit) return { ok: true, viaUnitAdminUnit: unit };

  return { ok: false, reason: "not_self" };
}
