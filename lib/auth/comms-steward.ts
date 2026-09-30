/**
 * `comms_steward` role resolution (Method-Family visibility steward,
 * `comms-steward-methods-visibility-spec.md` §3).
 *
 * `isCommsSteward(cwid)` answers "is this CWID a member of the comms-steward
 * group?" with a live LDAPS query against the WCM Enterprise Directory —
 * re-evaluated per request, never cached, exactly like `isSuperuser`
 * (`lib/auth/superuser.ts`, which this module mirrors). The verdict is paired
 * into `EditSession` as `isCommsSteward` by `getEditSession()`.
 *
 * The role is **global** (not per-scholar, not unit-scoped) and unlocks **only**
 * the Method-Family surface (§5–§7). It is NOT a superuser: it confers no
 * profile-field writes and no other `/edit` tabs. Superusers pass every
 * `comms_steward` guard (superset) — that direction lives in the authz
 * predicate, not here.
 *
 * The comms-steward group is a real Enterprise Directory group object under
 * `ou=Groups` (cn env `SCHOLARS_COMMS_STEWARD_GROUP_CN`, e.g.
 * `ITS:Library:Scholars/comms-steward-role`); membership is the group's
 * `member` attribute, which lists person DNs (`uid=<cwid>,ou=people,…`). The
 * check is one subtree search under `ou=Groups`: does the named group carry
 * this CWID's person DN in `member`?
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets and
 * TLS): this module, and anything importing it, must never be pulled into the
 * Edge middleware bundle — the same constraint `lib/auth/superuser.ts` carries.
 *
 * The whole role is gated by the `COMMS_STEWARD_ENABLED` kill switch (§9): when
 * it is not `"on"`, `isCommsSteward` short-circuits to `false` before any
 * directory work, so the route 404s and the APIs 404 regardless of group
 * membership.
 *
 * The check is **fail-closed**: a disabled flag, a missing group cn, an
 * unreachable directory, a bind failure, or a search error all resolve to "not
 * a comms steward". A directory problem can never *grant* the role.
 *
 * With `FUNCTIONAL_ROLES_AUTHZ` "on", an External Affairs grant carrying the
 * Communications function in `functional_role_grant` ALSO confers the role
 * (additive; `lib/auth/functional-role-authz.ts`). The kill switch above still
 * wins.
 */
import { isGroupMember } from "@/lib/auth/ldap-group";

/**
 * Whether the `comms_steward` role is enabled at all (§9 master kill switch).
 * `COMMS_STEWARD_ENABLED` must be exactly `"on"`; any other value (unset,
 * `"off"`, anything else) leaves the role dormant — `isCommsSteward` returns
 * `false` for everyone, the surface 404s.
 */
export function isCommsStewardEnabled(): boolean {
  return process.env.COMMS_STEWARD_ENABLED === "on";
}

/**
 * Whether to advertise the "Method Families" tab in the admin sub-nav for this
 * viewer: the surface is enabled AND the viewer can reach it (a comms_steward or
 * a superuser, §3 superset). Server-only (reads the `COMMS_STEWARD_ENABLED`
 * flag). Mirrors `isAdministratorsTabEnabled`'s role in the sub-nav, but also
 * role-gates so a unit Owner (who can land on some admin surfaces but is neither
 * steward nor superuser) is never shown a tab they can't open.
 */
export function isMethodsTabVisible(session: {
  isSuperuser: boolean;
  isCommsSteward: boolean;
}): boolean {
  return isCommsStewardEnabled() && (session.isSuperuser || session.isCommsSteward);
}


/**
 * Dev/interim allowlist — confers the `comms_steward` role WITHOUT LDAP.
 * `SCHOLARS_COMMS_STEWARD_ALLOWLIST` is a comma-separated CWID list, mirroring
 * `SCHOLARS_SUPERUSER_CWIDS`: the SPS VPC has no route to the WCM directory yet,
 * so the live group search below fails closed; this keeps a tightly-scoped
 * operator set able to use the Method-Family surface in the meantime. Lower-
 * cased + de-duplicated for case-insensitive matching; empty (the default) is a
 * no-op, leaving the LDAP group as the sole source of truth.
 */
function getCommsStewardAllowlist(): string[] {
  const raw = process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST;
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ];
}

/**
 * The comms_steward CWIDs that can be ENUMERATED, for the "View as" candidate
 * list (impersonation-spec.md §7). Today this is the interim allowlist only:
 * the LDAP group is the durable source of truth for the per-CWID
 * `isCommsSteward` check, but enumerating its `member` list is a separate
 * directory capability not yet built (and the group cn is unset everywhere
 * today). So a group-only steward will not yet *appear* as an impersonation
 * candidate — `isCommsSteward` still admits them at the per-target POST guard;
 * this gap is discoverability-only. Returns `[]` when the role is disabled (kill
 * switch), so a dark deployment surfaces no steward candidates. Lower-cased +
 * de-duplicated (via `getCommsStewardAllowlist`).
 */
export function listCommsStewardCwids(): string[] {
  if (!isCommsStewardEnabled()) return [];
  return getCommsStewardAllowlist();
}

/** Whether the functional-roles registry admits `cwid` as Communications.
 *  False without touching the DB while `FUNCTIONAL_ROLES_AUTHZ` is off; never
 *  throws (the registry read is itself fail-closed). */
async function registryAdmits(cwid: string): Promise<boolean> {
  if (process.env.FUNCTIONAL_ROLES_AUTHZ !== "on") return false;
  try {
    const { registryAdmitsExternalAffairs } = await import("@/lib/auth/functional-role-authz");
    return await registryAdmitsExternalAffairs(cwid, "communications");
  } catch {
    return false;
  }
}

/** One structured log line for a directory-side failure of the comms-steward check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(
    JSON.stringify({ event: "comms_steward_check_failed", reason, cwid }),
  );
}

/**
 * Whether `cwid` is a member of the comms-steward group, by a live LDAPS search
 * of the group's `member` attribute. Never throws — every failure mode (incl.
 * the disabled kill switch) resolves to `false`.
 */
export async function isCommsSteward(cwid: string): Promise<boolean> {
  // §9 master kill switch — short-circuit before any allowlist or directory
  // work. Flag-off leaves the role dormant for everyone.
  if (!isCommsStewardEnabled()) return false;
  if (!cwid) return false;
  // Interim allowlist — confers the role WITHOUT LDAP, checked before any
  // directory work (VPC↔WCM routing pending, so the live search fails closed).
  // Matched case-insensitively; empty/unset => no-op.
  if (getCommsStewardAllowlist().includes(cwid.toLowerCase())) return true;
  // Functional roles registry (additive, `FUNCTIONAL_ROLES_AUTHZ`): an
  // External Affairs grant carrying Communications also confers the role.
  // Loaded lazily so this module stays DB-free while the flag is off.
  if (await registryAdmits(cwid)) return true;
  const groupCn = process.env.SCHOLARS_COMMS_STEWARD_GROUP_CN;
  // Group cn not configured yet — the role is dormant, not broken.
  if (!groupCn) return false;

  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
}
