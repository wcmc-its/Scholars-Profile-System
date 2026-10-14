/**
 * Trial-status predicates with no imports, so a pure module (the area-signal
 * eligibility in lib/area-signals.ts) can share them with the profile reader
 * without pulling `@/lib/db` along. `lib/api/profile.ts` re-exports this.
 */

/** A trial we never display on the public profile: withdrawn / never-enrolled
 *  (ClinicalTrials.gov terms), or institutionally SUSPENDED — usually a
 *  temporary regulatory, safety or sponsor hold that a public "Suspended" label
 *  would misrepresent; if it reopens, OnCore flips it to OPEN TO ACCRUAL and it
 *  reappears. Admin reports still list it. Checked before the active test in
 *  lib/api/profile.ts so "no longer available" doesn't count as "available". */
export function isHiddenTrialStatus(status: string | null): boolean {
  const s = (status ?? "").toLowerCase();
  return s.includes("withdrawn") || s.includes("no longer available") || s.trim() === "suspended";
}
