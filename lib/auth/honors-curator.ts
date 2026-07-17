/**
 * `honors_curator` role resolution (#1762 — the honors approval queue).
 *
 * `isHonorsCurator(cwid)` answers "is this CWID a member of the honors-curator
 * group?" with a live LDAPS query against the WCM Enterprise Directory —
 * re-evaluated per request, never cached for the session, exactly like
 * `isSuperuser` (`lib/auth/superuser.ts`), `isCommsSteward`
 * (`lib/auth/comms-steward.ts`) and `isDeveloper` (`lib/auth/development.ts`),
 * which this module mirrors. The verdict is paired into `EditSession` as
 * `isHonorsCurator` by `getEditSession()` / `getEffectiveEditSession()`.
 *
 * The role is **global** (not per-scholar, not unit-scoped) and unlocks **only**
 * the `/edit/honors-queue` surface and its decision endpoint. It confers no
 * profile-field writes and no other `/edit` tabs. Superusers pass every
 * `honors_curator` guard (superset) — that direction lives in the authz
 * predicate at the call site (`isSuperuser || isHonorsCurator`), not here.
 *
 * WHY GLOBAL AND NOT unit_admin. The approver is the Research Dean's office,
 * which curates for EVERY scholar. `unit_admin` cannot express that: it is keyed
 * on a unit code with no wildcard, and `resolveEditableUnitViaUnitAdmin` computes
 * reach from the TARGET's own dept/div/center — so it goes dark entirely for any
 * scholar with none. Nor may this ride `authorizeOverviewWrite`, whose first leg
 * is `self`: a scholar would be able to approve the pending honor on their own
 * profile, which defeats the whole point of a human-confirmation gate on a roster
 * feed. A non-superuser global role is always added via a narrow predicate at its
 * own surface, never by widening a shared one — the same reason `slug` stays
 * superuser-only even for a comms_steward (`lib/edit/authz.ts`).
 *
 * WHY THE ROLE IS NAMED FOR THE FUNCTION, NOT THE OFFICE. The capability is
 * "curates honors"; the Research Dean's ED group is merely the membership source
 * that populates it. `research_dean` would break the moment the office is
 * reorganised, or the moment a second group needs the same capability.
 *
 * The honors-curator group is a real Enterprise Directory group object under
 * `ou=Groups` (cn env `SCHOLARS_HONORS_CURATOR_GROUP_CN`, e.g.
 * `ITS:Library:Scholars/honors-curator-role`). Like its three siblings it is an
 * OpenLDAP *dynamic* group (`objectClass: groupOfURLs`) — membership is a
 * `memberURL` LDAP-URL and `member` is synthesized by the dynlist overlay — so
 * the check is a group-DN resolve plus an LDAP `compare`. See
 * `lib/auth/ldap-group.ts` for why the single filtered search it replaced timed
 * out at 20–30 s.
 *
 * NOTE there is deliberately NO interim CWID allowlist here, unlike the three
 * older roles. Theirs exist because the SPS VPC once had no route to the WCM
 * directory, so the live group search failed closed and an env list was the only
 * way in. That routing landed (#1592) and the query was made correct+fast
 * (#1626); every one of those allowlists is now pinned `""` and kept only as
 * vestigial break-glass. Adding a fourth would be cargo-culting a workaround for
 * a solved problem. A superuser is already the fallback tier on every guard.
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets and
 * TLS): this module, and anything importing it, must never be pulled into the
 * Edge middleware bundle — the same constraint `lib/auth/superuser.ts` carries.
 *
 * The whole role is gated by the `HONORS_CURATOR_ENABLED` kill switch: when it is
 * not `"on"`, `isHonorsCurator` short-circuits to `false` before any directory
 * work, so the role is dormant for everyone and the queue stays superuser-only.
 *
 * The check is **fail-closed**: a disabled flag, a missing group cn, an
 * unreachable directory, a bind failure, or a search error all resolve to "not
 * an honors curator". A directory problem can never *grant* the role.
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/**
 * Whether the `honors_curator` role is enabled at all (master kill switch).
 * `HONORS_CURATOR_ENABLED` must be exactly `"on"`; any other value (unset,
 * `"off"`, anything else) leaves the role dormant — `isHonorsCurator` returns
 * `false` for everyone and `/edit/honors-queue` stays reachable to superusers
 * only.
 */
export function isHonorsCuratorEnabled(): boolean {
  return process.env.HONORS_CURATOR_ENABLED === "on";
}

/** One structured log line for a directory-side failure of the curator check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(
    JSON.stringify({ event: "honors_curator_check_failed", reason, cwid }),
  );
}

/**
 * Whether `cwid` is a member of the honors-curator group, by a live LDAPS lookup
 * of the group's `member` attribute. Never throws — every failure mode (incl. the
 * disabled kill switch) resolves to `false`.
 *
 * Wrapped in React `cache()`, keyed on `cwid` (mirroring `isSuperuser` /
 * `isDeveloper`), so a given CWID is resolved at most once per server request —
 * the LDAPS bind/lookup is deduped when the same CWID is checked by both
 * `getEffectiveEditSession` and the per-route gate within one request.
 * Request-scoped only: it does NOT cache across requests or for the session, so
 * the verdict is re-evaluated live on every `/edit` GET and every guarded API
 * call.
 */
export const isHonorsCurator = cache(async (cwid: string): Promise<boolean> => {
  // Master kill switch — short-circuit before any directory work. Flag-off leaves
  // the role dormant for everyone.
  if (!isHonorsCuratorEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_HONORS_CURATOR_GROUP_CN;
  // Group cn not configured yet — the role is dormant, not broken.
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
