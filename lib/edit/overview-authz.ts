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
 * Legs 2 and 3 key on the human who holds the grant: `realCwid` normally, and
 * under "View as" the viewed-as `impersonatedCwid` — but only after a live
 * `isSuperuser(realCwid)` re-check. Only a superuser can start an overlay and a
 * superuser may already write every scholar, so this confers nothing new; it
 * makes saves under View as a proxy / unit admin match the editor #3060 renders.
 * An overlay whose real human lost superuser is denied `not_self`. A granted proxy
 * that fails the conflict re-check is a hard `proxy_conflict` deny — it does NOT
 * fall through to the unit-admin leg (matches the field route's original flow).
 *
 * Returns `viaUnitAdminUnit` on a unit-admin allow so the caller can attribute
 * the edit in its B03 audit row. Pure of side effects (no logging) — each caller
 * logs its own `edit_authz_denied` at its own site, preserving its log shape.
 */
import { isSuperuser, type EditSession } from "@/lib/auth/superuser";
import { authorizeFieldEdit } from "@/lib/edit/authz";
import {
  checkProxyConflictingRole,
  isGrantedProxy,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";
import {
  resolveEditableUnitViaUnitAdmin,
  scholarsEditableViaUnitAdmin,
  type EditableUnit,
  type UnitScholarBatchLookup,
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

  // Delegated legs key on the grant holder: the real human, or under View as the
  // viewed-as user while the real human is still a live superuser (#3060 parity).
  let actor = realCwid;
  if (impersonatedCwid !== null) {
    if (!(await isSuperuser(realCwid).catch(() => false))) {
      return { ok: false, reason: "not_self" };
    }
    actor = impersonatedCwid;
  }

  // Leg 2 — scholar-assigned proxy (#779). The fail-closed D3/D4 conflict re-check
  // runs on the proxy's OWN cwid.
  if (await isGrantedProxy(actor, entityId, proxyDb)) {
    const conflict = await checkProxyConflictingRole(actor, proxyDb);
    return conflict.ok
      ? { ok: true, viaUnitAdminUnit: null }
      : { ok: false, reason: "proxy_conflict" };
  }

  // Leg 3 — org-unit owner/curator (#728 / Amendment 4). The resolver re-reads
  // `unit_admin` every call, so a lost role takes effect on the next request.
  const unit = await resolveEditableUnitViaUnitAdmin(actor, entityId, unitDb);
  if (unit) return { ok: true, viaUnitAdminUnit: unit };

  return { ok: false, reason: "not_self" };
}

/**
 * Authorization for the CV export surfaces (`POST /api/edit/cv` download,
 * `GET /api/edit/cv/outline` preview) — `authorizeOverviewWrite`, WIDENED with
 * the read-only observer role.
 *
 * Exporting a CV never writes anything (both routes' own doc comments: "nothing
 * is saved to the profile, no version row is persisted"), so admitting a
 * read-only role here doesn't leak write capability the way adding it to
 * `authorizeOverviewWrite` itself would — that predicate also backs 15+ genuine
 * mutation routes (field edits, appointment CRUD, honor/news-mention decisions,
 * biosketch generation), which must stay closed to observers. Keeping the
 * widening in its own function is what stops a third CV-adjacent route from
 * drifting out of sync.
 */
export async function authorizeCvExport(args: {
  session: EditSession;
  realCwid: string;
  impersonatedCwid: string | null;
  entityId: string;
  proxyDb: ProxyLookup;
  unitDb: UnitScholarLookup;
}): Promise<OverviewWriteAuthz> {
  const authz = await authorizeOverviewWrite(args);
  if (authz.ok) return authz;
  // An observer may export too: a CV writes nothing and shows nothing the
  // observer can't already read (decision 2026-10-01). The download is a POST, whose write preamble strips the
  // session's observer flag (`stripObserverView`), so ask about the REAL cwid.
  // Not under "View as": the overlay's own roles decide there. Loaded lazily so
  // the routes sharing this module keep an LDAP-free import graph.
  if (args.impersonatedCwid === null) {
    const { isObserver } = await import("@/lib/auth/observer");
    if (await isObserver(args.realCwid)) return { ok: true, viaUnitAdminUnit: null };
  }
  return authz;
}

/** What {@link cvExportAllowedAmong} reads: the proxy grants of one person
 *  among a set of scholars, and the unit-admin batch surface. */
export type CvExportBatchLookup = UnitScholarBatchLookup & {
  scholarProxy: {
    findMany: (args: {
      where: { proxyCwid: string; scholarCwid: { in: string[] } };
      select: { scholarCwid: true };
    }) => Promise<Array<{ scholarCwid: string }>>;
  };
};

/**
 * {@link authorizeCvExport} for MANY scholars at once: which of `entityIds`
 * it would allow. For a page that decides, per row, whether to offer a link
 * to a CV-export surface (the Bibliometrics report). A fixed handful of
 * reads, however many scholars. It only decides what to SHOW: the surface
 * behind the link still runs `authorizeCvExport` on the one scholar.
 *
 * Same legs, same order: self, superuser, comms steward or content editor;
 * a granted proxy (a superuser proxy is a conflict and does not fall through
 * to the unit leg); an org-unit owner or curator; then, outside "View as",
 * the observer role, which allows everyone the earlier legs refused.
 * `tests/unit/cv-export-batch.test.ts` holds the two to the same answers.
 */
export async function cvExportAllowedAmong(args: {
  session: EditSession;
  realCwid: string;
  impersonatedCwid: string | null;
  entityIds: readonly string[];
  db: CvExportBatchLookup;
}): Promise<Set<string>> {
  const { session, realCwid, impersonatedCwid, db } = args;
  const ids = [...new Set(args.entityIds)].filter(Boolean);
  const allowed = new Set(
    ids.filter((entityId) => authorizeFieldEdit(session, { entityId, fieldName: "overview" }).ok),
  );
  let rest = ids.filter((id) => !allowed.has(id));
  if (rest.length === 0) return allowed;

  if (impersonatedCwid === null) {
    const { isObserver } = await import("@/lib/auth/observer");
    if (await isObserver(realCwid)) return new Set(ids);
  } else if (!(await isSuperuser(realCwid).catch(() => false))) {
    return allowed;
  }
  const actor = impersonatedCwid ?? realCwid;

  const proxied = await db.scholarProxy.findMany({
    where: { proxyCwid: actor, scholarCwid: { in: rest } },
    select: { scholarCwid: true },
  });
  if (proxied.length > 0) {
    const conflict = await checkProxyConflictingRole(actor, db as unknown as ProxyLookup);
    const served = new Set(proxied.map((r) => r.scholarCwid));
    if (conflict.ok) for (const cwid of served) allowed.add(cwid);
    rest = rest.filter((id) => !served.has(id));
  }

  for (const cwid of await scholarsEditableViaUnitAdmin(actor, rest, db)) allowed.add(cwid);
  return allowed;
}
