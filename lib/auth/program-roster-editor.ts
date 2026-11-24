/**
 * `program_roster_editor` role resolution (internal program roster, 2026-11).
 *
 * A live LDAPS group check, the same shape as `research-security-viewer.ts`
 * (no interim allowlist, one group, never cached past the request). The role
 * unlocks ONLY the program roster on `/edit`: read and write there, nothing
 * else. It is paired into `EditSession` as `isProgramRosterEditor`; the gates
 * are in `lib/edit/program-roster-access.ts`.
 *
 * WHY ITS OWN ROLE. Roster rows name trainees, some of them minors. No
 * existing role has that audience: comms stewards, observers, content editors,
 * unit Owners / Curators and Reporting holders must NOT see it.
 *
 * Fail-closed: the flag off, no group cn, or any directory problem resolves to
 * "not an editor". `EDIT_PROGRAM_ROSTER` is the feature flag AND the kill
 * switch, so nothing is asked of the directory until the roster is on (a group
 * that does not exist yet would trip the role-check alarm).
 *
 * Node-runtime only (reuses `lib/sources/ldap.ts`).
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/** The program roster's one switch: `EDIT_PROGRAM_ROSTER` must be exactly `"on"`. */
export function isProgramRosterEnabled(): boolean {
  return process.env.EDIT_PROGRAM_ROSTER === "on";
}

function logCheckFailed(cwid: string, reason: string): void {
  console.warn(JSON.stringify({ event: "program_roster_editor_check_failed", reason, cwid }));
}

/** Whether `cwid` is in the program-roster-editor group. Never throws. */
export const isProgramRosterEditor = cache(async (cwid: string): Promise<boolean> => {
  if (!isProgramRosterEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_PROGRAM_ROSTER_EDITOR_GROUP_CN;
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
