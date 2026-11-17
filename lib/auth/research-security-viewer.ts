/**
 * `research_security_viewer` role resolution (research security dashboard,
 * 2026-11).
 *
 * `isResearchSecurityViewer(cwid)` answers "is this CWID a member of the
 * research-security-viewer group?" with a live LDAPS query against the WCM
 * Enterprise Directory, re-evaluated per request and never cached for the
 * session. It mirrors `lib/auth/data-sharing-viewer.ts` exactly (no interim
 * allowlist, one kill switch, one group); the verdict is paired into
 * `EditSession` as `isResearchSecurityViewer` by `getEditSession()` /
 * `getEffectiveEditSession()`.
 *
 * The role is **global** and unlocks **only** `/edit/research-security` and
 * its export: a read-only dashboard, no writes, no other `/edit` tab. One
 * group sees both campuses (decision 2026-11-16). Superusers already pass the
 * dashboard's gate; the OR lives in `dashboardBirthright`
 * (`lib/edit/dashboard-access.ts`), not here.
 *
 * WHY ITS OWN ROLE. The dashboard holds per-person screening results for the
 * export-controls and research-security office. No existing role has that
 * audience, and `comms_steward`, `observer` and `data_sharing_viewer` must NOT
 * see it: a non-superuser global role is always added via a narrow predicate
 * at its own surface, never by widening a shared one.
 *
 * The group is an Enterprise Directory group object under `ou=Groups` (cn env
 * `SCHOLARS_RESEARCH_SECURITY_VIEWER_GROUP_CN`, e.g.
 * `ITS:Library:Scholars/research-security-viewer-role`), the same shape as its
 * siblings. See `lib/auth/ldap-group.ts`.
 *
 * Node-runtime only (reuses `lib/sources/ldap.ts`): never pull this into the
 * Edge middleware bundle.
 *
 * Gated by the `RESEARCH_SECURITY_VIEWER_ENABLED` kill switch, and
 * **fail-closed**: a disabled flag, a missing group cn, an unreachable
 * directory, a bind failure or a search error all resolve to "not a viewer".
 * A directory problem can never grant the role.
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/** Master kill switch: `RESEARCH_SECURITY_VIEWER_ENABLED` must be exactly `"on"`. */
export function isResearchSecurityViewerEnabled(): boolean {
  return process.env.RESEARCH_SECURITY_VIEWER_ENABLED === "on";
}

function logCheckFailed(cwid: string, reason: string): void {
  console.warn(JSON.stringify({ event: "research_security_viewer_check_failed", reason, cwid }));
}

/**
 * Whether `cwid` is a member of the research-security-viewer group. Never
 * throws: every failure mode resolves to `false`. Wrapped in React `cache()`
 * keyed on `cwid`, so one request resolves a CWID at most once; it does not
 * cache across requests.
 */
export const isResearchSecurityViewer = cache(async (cwid: string): Promise<boolean> => {
  if (!isResearchSecurityViewerEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_RESEARCH_SECURITY_VIEWER_GROUP_CN;
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
