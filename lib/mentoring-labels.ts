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
 *  Two sources feed this with overlapping populations (AOC's MDPHD vs
 *  Jenzabar's MD-PhD; nothing vs Jenzabar's PhD), so the mapping
 *  intentionally normalizes both to the same "<degree> mentee" form
 *  to avoid two separate groups on the rollup page for what's
 *  effectively the same trainee bucket.
 *
 *   AOC / AOC-2025      → "MD mentee"        (AOC acronym not exposed)
 *   MDPHD / MD-PhD      → "MD-PhD mentee"
 *   PhD                 → "PhD mentee"
 *   ECR                 → "Early career mentee"
 *   anything else       → passed through unchanged
 */
export function formatProgramLabel(programType: string | null): string | null {
  if (!programType) return null;
  if (programType === "AOC" || programType.startsWith("AOC-")) return "MD mentee";
  if (programType === "MDPHD" || programType === "MD-PhD") return "MD-PhD mentee";
  if (programType === "PhD") return "PhD mentee";
  if (programType === "ECR") return "Early career mentee";
  return programType;
}
