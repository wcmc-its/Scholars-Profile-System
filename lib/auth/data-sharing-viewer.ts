/**
 * `data_sharing_viewer` role resolution (2026-08-15 — data-sharing dashboard
 * handoff, item "Create role for access to data sharing dashboard").
 *
 * `isDataSharingViewer(cwid)` answers "is this CWID a member of the
 * data-sharing-viewer group?" with a live LDAPS query against the WCM
 * Enterprise Directory — re-evaluated per request, never cached for the
 * session, exactly like `isSuperuser` (`lib/auth/superuser.ts`),
 * `isCommsSteward` (`lib/auth/comms-steward.ts`) and `isHonorsCurator`
 * (`lib/auth/honors-curator.ts`), which this module mirrors most closely
 * (same shape: no interim allowlist, one kill switch, one group). The
 * verdict is paired into `EditSession` as `isDataSharingViewer` by
 * `getEditSession()` / `getEffectiveEditSession()`.
 *
 * The role is **global** (not per-scholar, not unit-scoped) and unlocks
 * **only** the `/edit/data-sharing` dashboard — a read-only rollup, no
 * writes on that surface either way. It confers no profile-field writes and
 * no other `/edit` tabs. Superusers and comms_stewards already pass every
 * `data_sharing_viewer` guard (the dashboard's audience is `superuser ||
 * comms_steward || data_sharing_viewer`) — this role exists for the
 * research-leadership / compliance-grant-reporting / library-RDM audience
 * who are neither. That OR direction lives in the authz predicate at the
 * call site (`canViewDataSharingDashboard`,
 * `lib/edit/data-sharing-dashboard.ts`), not here.
 *
 * WHY A NEW ROLE AND NOT `comms_steward`. `comms_steward` is a Method-Family
 * visibility role for External Affairs — a different office, a different
 * surface, a different membership. Widening it to cover data-sharing
 * reporting would mean anyone added for one purpose silently gets the other.
 * A non-superuser global role is always added via a narrow predicate at its
 * own surface, never by widening a shared one — same reasoning as
 * `honors-curator.ts`'s own docblock.
 *
 * The data-sharing-viewer group is a real Enterprise Directory group object
 * under `ou=Groups` (cn env `SCHOLARS_DATA_SHARING_VIEWER_GROUP_CN`, e.g.
 * `ITS:Library:Scholars/data-sharing-viewer-role`), structurally identical to
 * its three siblings: an OpenLDAP *dynamic* group (`objectClass:
 * groupOfURLs`) under `ou=application security`, membership synthesized by
 * the dynlist overlay. See `lib/auth/ldap-group.ts` for why this is a
 * group-DN resolve plus an LDAP `compare`, not a single filtered search.
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets
 * and TLS): this module, and anything importing it, must never be pulled
 * into the Edge middleware bundle — the same constraint every sibling role
 * carries.
 *
 * The whole role is gated by the `DATA_SHARING_VIEWER_ENABLED` kill switch:
 * when it is not `"on"`, `isDataSharingViewer` short-circuits to `false`
 * before any directory work, so the role is dormant for everyone and the
 * dashboard stays superuser/comms_steward-only.
 *
 * The check is **fail-closed**: a disabled flag, a missing group cn, an
 * unreachable directory, a bind failure, or a search error all resolve to
 * "not a data-sharing viewer". A directory problem can never *grant* the
 * role. Membership is a directory-side change, not a code deploy — adding or
 * removing a `memberURL` on the ED group takes effect immediately, with no
 * redeploy of this app.
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/**
 * Whether the `data_sharing_viewer` role is enabled at all (master kill
 * switch). `DATA_SHARING_VIEWER_ENABLED` must be exactly `"on"`; any other
 * value (unset, `"off"`, anything else) leaves the role dormant —
 * `isDataSharingViewer` returns `false` for everyone and `/edit/data-sharing`
 * stays reachable to superusers and comms_stewards only.
 */
export function isDataSharingViewerEnabled(): boolean {
  return process.env.DATA_SHARING_VIEWER_ENABLED === "on";
}

/** One structured log line for a directory-side failure of the viewer check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(JSON.stringify({ event: "data_sharing_viewer_check_failed", reason, cwid }));
}

/**
 * Whether `cwid` is a member of the data-sharing-viewer group, by a live
 * LDAPS lookup of the group's `member` attribute. Never throws — every
 * failure mode (incl. the disabled kill switch) resolves to `false`.
 *
 * Wrapped in React `cache()`, keyed on `cwid` (mirroring `isSuperuser` /
 * `isHonorsCurator`), so a given CWID is resolved at most once per server
 * request — the LDAPS bind/lookup is deduped when the same CWID is checked
 * by both `getEffectiveEditSession` and the per-route gate within one
 * request. Request-scoped only: it does NOT cache across requests or for the
 * session, so the verdict is re-evaluated live on every `/edit` GET.
 */
export const isDataSharingViewer = cache(async (cwid: string): Promise<boolean> => {
  // Master kill switch — short-circuit before any directory work. Flag-off
  // leaves the role dormant for everyone.
  if (!isDataSharingViewerEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_DATA_SHARING_VIEWER_GROUP_CN;
  // Group cn not configured yet — the role is dormant, not broken.
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
