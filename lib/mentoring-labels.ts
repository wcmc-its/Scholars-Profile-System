/**
 * Pure-function mentoring label helpers — safe to import from client
 * components. `lib/api/mentoring.ts` re-exports `formatProgramLabel` for
 * server-side callers, but the standalone module here keeps the client
 * bundle free of prisma / Node-crypto dependencies (issue #189 caught
 * this when mentoring-section.tsx started importing the helper).
 */

/** Map a raw `programType` value to the user-facing bucket label that
 *  appears in chip subtitles and rollup section headings.
 *
 *  AOC / AOC-2025 collapse to "MD mentee" — the AOC acronym is not
 *  exposed in the UI. MDPHD / ECR get their longer forms. PhD and
 *  MD-PhD from the Jenzabar source pass through as-is. */
export function formatProgramLabel(programType: string | null): string | null {
  if (!programType) return null;
  if (programType === "AOC" || programType.startsWith("AOC-")) return "MD mentee";
  if (programType === "MDPHD") return "MD-PhD mentee";
  if (programType === "ECR") return "Early career mentee";
  return programType;
}
