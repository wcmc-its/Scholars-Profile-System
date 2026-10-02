/**
 * `content_editor` role resolution: staff who edit profile and unit content
 * across the whole site (the WCM webmaster, Ops staff) without the steward's
 * governance powers.
 *
 * `isContentEditor(cwid)` answers "is this CWID a member of the content-editor
 * group?" with a live LDAPS query against the WCM Enterprise Directory —
 * re-evaluated per request, never cached for the session, exactly like its
 * siblings (`observer.ts`, `honors-curator.ts`).
 *
 * HOW THE ROLE WORKS. Reads look like a steward's: a content editor who is not
 * already a superuser or comms_steward gets a SYNTHETIC `isCommsSteward: true`
 * on the READ session, flagged `isContentEditor: true`
 * (`withContentEditorView`, `lib/auth/observer-view.ts`), so every console page
 * renders with no per-page wiring — the same mechanism the observer uses.
 * Writes are an ALLOWLIST: `resolveEditIdentityForWrite` strips the synthetic
 * steward grant and keeps `isContentEditor`, and only the write predicates
 * that name `isContentEditor` admit it — profile content (bio, Highlights,
 * mentees, title requests, one-profile hides), units, centers and cores, the
 * news queues and Method Families. Never: granting Owner/Curator or report
 * access, pinning a display title, the Titles queue, takedowns, hiding a whole
 * scholar, the role vocabulary, slugs. A steward feature added later stays
 * closed to content editors until someone adds them to its predicate.
 *
 * A content editor also reads everything an observer reads (the queues and
 * dashboards) and may start a read-only "View as".
 *
 * Kill switch `CONTENT_EDITOR_ENABLED` (exactly `"on"`); group cn
 * `SCHOLARS_CONTENT_EDITOR_GROUP_CN`. Fail-closed: flag off, cn unset,
 * directory down all resolve to "not a content editor". Node-runtime only
 * (LDAPS).
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/** Master kill switch. Anything but exactly `"on"` leaves the role dormant. */
export function isContentEditorEnabled(): boolean {
  return process.env.CONTENT_EDITOR_ENABLED === "on";
}

function logCheckFailed(cwid: string, reason: string): void {
  console.warn(JSON.stringify({ event: "content_editor_check_failed", reason, cwid }));
}

/** Whether `cwid` is in the content-editor group. Never throws; request-scoped `cache()`. */
export const isContentEditor = cache(async (cwid: string): Promise<boolean> => {
  if (!isContentEditorEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_CONTENT_EDITOR_GROUP_CN;
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
