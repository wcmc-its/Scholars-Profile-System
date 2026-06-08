/**
 * Scholar-assigned proxy editor — authorization predicates
 * (scholar-proxy-spec.md / #779, ADR-005 Amendment 3).
 *
 * Kept in a dedicated module so `lib/edit/authz.ts` stays the self-edit / #540
 * unit-role predicate set and the two authorization axes never blur. These
 * predicates touch the DB (a grant lookup; the three-leg "no other role" check),
 * so — unlike `authz.ts`'s pure synchronous predicates — they are async by
 * necessity. The DB surface is a minimal structural type so unit tests mock it;
 * `db.read` / `db.write` satisfy it (cast at the call site, mirroring
 * `UnitAdminLookup`).
 *
 * THE LOAD-BEARING RULE (scholar-proxy-spec.md § Authorization): every proxy
 * authorization decision keys on the REAL signed-in cwid (`EditRequestContext.
 * realCwid`), NEVER `session.cwid` / `effective.cwid`. While a #637 "View as"
 * overlay is live, `session.cwid` is the impersonation TARGET; a proxy lookup
 * keyed on it would let a superuser impersonate a proxy (or the scholar) and
 * inherit the proxy path. A proxy is its own real identity and is NEVER an
 * impersonator — callers also assert `impersonatedCwid === null` before taking
 * the proxy branch.
 */
import { isSuperuser } from "@/lib/auth/superuser";

/**
 * Why a CWID is ineligible to hold a proxy grant (D3, narrowed by Amendment 4
 * D4). A scholar or org-unit administrator is NO LONGER a conflict — a roled
 * person may be an explicitly-assigned proxy; only a superuser is rejected (the
 * grant would be a meaningless no-op). Kept as a one-member union (rather than a
 * bare boolean) so the SERVER-SIDE structured log stays specific; the HTTP layer
 * still collapses it to an opaque `proxy_ineligible` so the grant endpoint is not
 * a role-oracle (scholar-proxy-spec.md threat CD-6).
 */
export type ProxyConflictReason =
  /** the candidate is in the superuser group — the grant would be meaningless */
  | "proxy_is_superuser";

export type ProxyConflictResult =
  | { ok: true }
  | { ok: false; reason: ProxyConflictReason };

/**
 * Minimal Prisma surface the per-edit / per-grant proxy predicates read.
 * `db.read` / `db.write` satisfy it structurally; cast at the call site
 * (`db.read as unknown as ProxyLookup`), mirroring `UnitAdminLookup` in
 * `authz.ts`.
 *
 * The `scholar` / `unitAdmin` members are retained for call-site + test-mock
 * stability only: {@link checkProxyConflictingRole} no longer reads them now that
 * Amendment 4 D4 dropped the scholar / unit-admin conflict legs (the sole
 * remaining leg, superuser, comes from `isSuperuserFn`). `db.read` satisfies the
 * wider shape trivially, so they cost nothing to keep and avoid churning the four
 * cast sites.
 */
export type ProxyLookup = {
  scholarProxy: {
    findUnique: (args: {
      where: { scholarCwid_proxyCwid: { scholarCwid: string; proxyCwid: string } };
      select: { scholarCwid: true };
    }) => Promise<{ scholarCwid: string } | null>;
  };
  scholar: {
    findUnique: (args: {
      where: { cwid: string };
      select: { deletedAt: true };
    }) => Promise<{ deletedAt: Date | null } | null>;
  };
  unitAdmin: {
    findFirst: (args: {
      where: { cwid: string };
      select: { cwid: true };
    }) => Promise<{ cwid: string } | null>;
  };
};

/** The reverse-lookup surface for "which scholars does this proxy serve?" — the
 *  read-only landing redirect and the drift audit. A `findMany` on `proxyCwid`
 *  is acceptable HERE (read-only); it is NEVER used for a write authorization,
 *  which always binds the exact (scholarCwid, proxyCwid) pair via
 *  {@link isGrantedProxy} (threat PE-06). */
export type ProxyListLookup = {
  scholarProxy: {
    findMany: (args: {
      where: { proxyCwid: string };
      select: { scholarCwid: true };
    }) => Promise<Array<{ scholarCwid: string }>>;
  };
};

/**
 * Is `realCwid` an active proxy for the EXACT scholar `scholarCwid`?
 *
 * A COMPOSITE-PK `findUnique` — never a `findFirst` on `proxyCwid` alone, which
 * would let a proxy of scholar A edit scholar B (threat PE-06). Hard-delete
 * means row existence is the whole answer: there is no `revokedAt` column and
 * therefore no `revokedAt IS NULL` filter (threat CD-8). The lookup is a
 * per-request DB read, never cached, so a revoke takes effect on the very next
 * request.
 */
export async function isGrantedProxy(
  realCwid: string,
  scholarCwid: string,
  db: ProxyLookup,
): Promise<boolean> {
  if (!realCwid || !scholarCwid) return false;
  const row = await db.scholarProxy.findUnique({
    where: { scholarCwid_proxyCwid: { scholarCwid, proxyCwid: realCwid } },
    select: { scholarCwid: true },
  });
  return row !== null;
}

/**
 * D3 "no other role", narrowed to the superuser leg (Amendment 4 D4) —
 * fail-closed. Returns `{ ok: false, reason: "proxy_is_superuser" }` iff the
 * candidate is a live superuser, else `{ ok: true }`.
 *
 * A scholar or org-unit administrator is NO LONGER a conflict: Amendment 4
 * deliberately allows a roled person to be an explicitly-assigned proxy (the
 * institutional reality is that delegates hold roles). The one invariant kept is
 * "a proxy may not be a superuser" — a superuser already edits everything via the
 * superuser path, so a proxy grant to them is a meaningless no-op.
 *
 * Runs the live `isSuperuser` leg — NOT deferred (threats PE-02 / CD-3 / IS-7).
 * Called BLOCKING at grant time, and fail-closed at EVERY proxy edit, always on
 * the candidate's OWN cwid (the proxy path passes `realCwid`, because the request
 * preamble computes `isSuperuser` only for the EFFECTIVE cwid — a proxy's own
 * superuser status is otherwise never checked).
 *
 * `isSuperuserFn` defaults to the real LDAPS-backed {@link isSuperuser} (itself
 * fail-closed: a directory outage resolves to "not a superuser"); it is a
 * parameter only so unit tests inject a stub instead of reaching LDAP.
 *
 * `_db` is retained on the signature purely for call-site stability — the four
 * callers cast `db.read as unknown as ProxyLookup` — and is no longer read now
 * that the scholar / unit-admin legs are gone.
 */
export async function checkProxyConflictingRole(
  cwid: string,
  _db: ProxyLookup,
  isSuperuserFn: (cwid: string) => Promise<boolean> = isSuperuser,
): Promise<ProxyConflictResult> {
  if (await isSuperuserFn(cwid)) return { ok: false, reason: "proxy_is_superuser" };
  return { ok: true };
}

/**
 * The scholars a proxy serves — the read-only reverse lookup backing the
 * non-scholar `/edit` landing redirect (one grant ⇒ redirect; many ⇒ a minimal
 * landing list) and the drift audit. NEVER a write-authorization input.
 */
export async function scholarsServedByProxy(
  proxyCwid: string,
  db: ProxyListLookup,
): Promise<string[]> {
  if (!proxyCwid) return [];
  const rows = await db.scholarProxy.findMany({
    where: { proxyCwid },
    select: { scholarCwid: true },
  });
  return rows.map((r) => r.scholarCwid);
}
