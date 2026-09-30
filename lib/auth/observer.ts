/**
 * `observer` role resolution — read-only console access for trusted staff
 * (Web Operations, Academic/Faculty Affairs, ITS liaisons) so they understand
 * the app and can guide users through real changes on prod.
 *
 * `isObserver(cwid)` answers "is this CWID a member of the observer group?"
 * with a live LDAPS query against the WCM Enterprise Directory — re-evaluated
 * per request, never cached for the session, exactly like its siblings
 * (`data-sharing-viewer.ts`, `honors-curator.ts`, `cv-generator.ts`).
 *
 * HOW THE ROLE WORKS (unlike its narrow siblings, it is not a per-surface
 * predicate). An observer who is not already a superuser or comms_steward is
 * given a SYNTHETIC `isCommsSteward: true` on the READ session, flagged
 * `isObserver: true` (`getEditSession` / `getEffectiveEditSession`), so every
 * console page, queue and report renders exactly as a steward sees it with no
 * per-page wiring. Writes never see that synthetic grant: `readEditRequest`
 * and `resolveEditIdentityForWrite` (`lib/edit/request.ts`) strip it back off
 * before any write predicate runs, so a write is authorized by the person's
 * OWN roles only. Someone who is faculty + observer still self-edits; a unit
 * curator + observer still curates their unit; a steward-only write 403s.
 *
 * "View as" (#637): an observer may start it (`canImpersonate`), but every
 * write under an overlay a non-superuser started is refused
 * (`impersonation_readonly`) — otherwise viewing as a curator would write as
 * that curator.
 *
 * Kill switch `OBSERVER_ENABLED` (exactly `"on"`); group cn
 * `SCHOLARS_OBSERVER_GROUP_CN`. Fail-closed: flag off, cn unset, directory
 * down all resolve to "not an observer". Node-runtime only (LDAPS).
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/** Master kill switch. Anything but exactly `"on"` leaves the role dormant. */
export function isObserverEnabled(): boolean {
  return process.env.OBSERVER_ENABLED === "on";
}

function logCheckFailed(cwid: string, reason: string): void {
  console.warn(JSON.stringify({ event: "observer_check_failed", reason, cwid }));
}

/** Whether `cwid` is in the observer group. Never throws; request-scoped `cache()`. */
export const isObserver = cache(async (cwid: string): Promise<boolean> => {
  if (!isObserverEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_OBSERVER_GROUP_CN;
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
