/**
 * Scholar-assigned proxy editor — D3 DRIFT AUDIT (scholar-proxy-spec.md § Audit
 * queries, query D / #779).
 *
 * D3 ("the proxy holds no other role") is enforced at grant time (blocking) and
 * re-checked fail-closed at EVERY proxy edit — so a proxy who LATER acquires a
 * conflicting role is already DENIED the proxy path on their next request
 * (threats PE-02 / IS-7). The grant ROW, however, lingers. Auto-revoke was
 * rejected as too invasive — it would need a hook on every role-acquisition
 * path (spec § "Rejected alternative — auto-revoke on conflict"); the chosen
 * remedy is this SCHEDULED audit, which flags the stale grants so an operator
 * can revoke them manually.
 *
 * It reuses {@link checkProxyConflictingRole} with the live `isSuperuser` leg
 * STUBBED to `false`: query D is explicit that the superuser leg "is checked
 * live per-edit (fail-closed) and cannot be expressed in SQL; this catches the
 * DB legs" (Scholar / UnitAdmin). Reusing the enforcement predicate guarantees
 * the audit's notion of a conflict stays byte-identical to the two DB legs the
 * per-edit check denies on — the audit can never drift from enforcement.
 *
 * Read-only. It never revokes (the per-edit check already disables the path);
 * remediation is a manual `POST /api/edit/proxy {action:"revoke"}`.
 */
import {
  checkProxyConflictingRole,
  type ProxyConflictReason,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";

/** One drifted grant: an active proxy who has since acquired a conflicting DB role. */
export interface ProxyDriftHit {
  scholarCwid: string;
  proxyCwid: string;
  grantedAt: Date;
  /**
   * Which DB leg conflicts — `proxy_is_scholar` or `proxy_is_unit_admin`. Never
   * `proxy_is_superuser`: that leg is stubbed off here (see module doc), so the
   * audit cannot emit it.
   */
  conflictingRole: Exclude<ProxyConflictReason, "proxy_is_superuser">;
}

export interface ProxyDriftResult {
  /** Total active grants scanned. */
  totalGrants: number;
  /** The subset whose proxy now holds a conflicting Scholar / UnitAdmin role. */
  drifted: ProxyDriftHit[];
}

/**
 * The DB surface this audit reads: every active grant (`scholarProxy.findMany`)
 * plus the two conflict legs {@link checkProxyConflictingRole} reads
 * (`scholar.findUnique` + `unitAdmin.findFirst`). `db.read` satisfies it
 * structurally; cast at the call site (`db.read as unknown as ProxyDriftLookup`),
 * mirroring `ProxyLookup` in `proxy-authz.ts`.
 */
export type ProxyDriftLookup = {
  scholarProxy: {
    findMany: (args: {
      select: { scholarCwid: true; proxyCwid: true; createdAt: true };
    }) => Promise<Array<{ scholarCwid: string; proxyCwid: string; createdAt: Date }>>;
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

/**
 * Scan every active grant and return the ones whose proxy now holds a
 * conflicting Scholar / UnitAdmin role. Read-only; the superuser leg is out of
 * scope (stubbed `false`) — see the module doc.
 */
export async function auditProxyDrift(db: ProxyDriftLookup): Promise<ProxyDriftResult> {
  const grants = await db.scholarProxy.findMany({
    select: { scholarCwid: true, proxyCwid: true, createdAt: true },
  });
  const drifted: ProxyDriftHit[] = [];
  for (const grant of grants) {
    // Stub the superuser leg to `false`: query D catches only the DB legs (the
    // live superuser leg is the per-edit check's job). Reusing the real
    // predicate keeps the audit aligned with enforcement (scholar + unit_admin).
    const conflict = await checkProxyConflictingRole(
      grant.proxyCwid,
      db as unknown as ProxyLookup,
      async () => false,
    );
    if (!conflict.ok && conflict.reason !== "proxy_is_superuser") {
      drifted.push({
        scholarCwid: grant.scholarCwid,
        proxyCwid: grant.proxyCwid,
        grantedAt: grant.createdAt,
        conflictingRole: conflict.reason,
      });
    }
  }
  return { totalGrants: grants.length, drifted };
}
