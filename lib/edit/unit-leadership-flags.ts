/**
 * Vice Chair roles on `/edit` (`UnitLeadershipRole`, `lib/unit-leadership.ts`).
 * Read lazily, never at module load. Off by default: dark until a manual
 * `cdk deploy`. SERVER-ONLY.
 */
export function isUnitLeadershipEnabled(): boolean {
  return process.env.UNIT_LEADERSHIP_ROLES === "on";
}
