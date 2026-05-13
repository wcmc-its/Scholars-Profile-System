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
 *  Three sources feed this with overlapping populations (AOC's MDPHD vs
 *  Jenzabar's MD-PhD; nothing vs Jenzabar's PhD; ED's postdoc records),
 *  so the mapping intentionally normalizes overlaps to the same
 *  "<degree> mentee" form to avoid duplicate groups on the rollup page
 *  for what's effectively the same trainee bucket.
 *
 *   AOC / AOC-2025      → "MD mentee"        (AOC acronym not exposed)
 *   MDPHD / MD-PhD      → "MD-PhD mentee"
 *   PhD                 → "PhD mentee"
 *   POSTDOC             → "Postdoc mentee"   (issue #183)
 *   ECR                 → "Early career mentee"
 *   anything else       → passed through unchanged
 */
export function formatProgramLabel(programType: string | null): string | null {
  if (!programType) return null;
  if (programType === "AOC" || programType.startsWith("AOC-")) return "MD mentee";
  if (programType === "MDPHD" || programType === "MD-PhD") return "MD-PhD mentee";
  if (programType === "PhD") return "PhD mentee";
  if (programType === "POSTDOC") return "Postdoc mentee";
  if (programType === "ECR") return "Early career mentee";
  return programType;
}

/** Issue #201 — at or above this mentee count, the section header switches
 *  from the bare "N mentees" subhead to a degree-bucket distribution. The
 *  formal addendum on #201 also ties this threshold to the grouped-grid
 *  layout introduced in Slice B; the constant lives in this client-safe
 *  module so both surfaces share the same number. Defined as a named
 *  constant so the eventual recalibration after measuring real scholar
 *  distributions changes one line, not several. */
export const MENTORING_DISTRIBUTION_THRESHOLD = 8;

/** Degree-bucket label used in the section-header distribution subhead.
 *  Coarser than `formatProgramLabel` — collapses PhD program names to a
 *  single "PhD" bucket regardless of `programName`. Order of the union
 *  matches the render order in `formatMentoringDistribution`. */
export type MentoringDistributionBucket =
  | "MD"
  | "PhD"
  | "MD-PhD"
  | "Postdoc"
  | "ECR"
  | "other";

const DISTRIBUTION_BUCKET_ORDER: MentoringDistributionBucket[] = [
  "MD",
  "PhD",
  "MD-PhD",
  "Postdoc",
  "ECR",
  "other",
];

/** Map a raw `programType` to the coarse distribution bucket used in the
 *  section-header subhead. Distinct from `formatProgramLabel` (which is
 *  per-chip and may keep finer program names): the subhead is a one-line
 *  summary of the mentorship portfolio's shape, so PhD program names
 *  collapse into a single "PhD" bucket. */
export function mentoringDistributionBucket(
  programType: string | null,
): MentoringDistributionBucket {
  if (!programType) return "other";
  if (programType === "AOC" || programType.startsWith("AOC-")) return "MD";
  if (programType === "MDPHD" || programType === "MD-PhD") return "MD-PhD";
  if (programType === "PhD") return "PhD";
  if (programType === "POSTDOC") return "Postdoc";
  if (programType === "ECR") return "ECR";
  return "other";
}

/** Format the degree-bucket distribution for the Mentoring section
 *  subhead — e.g. `"7 MD · 8 PhD · 6 MD-PhD · 3 Postdoc"`.
 *
 *  Returns `null` when the distribution should not render and the caller
 *  should fall back to the plain "N mentees" subhead. Two suppression
 *  cases:
 *
 *   - Fewer than `MENTORING_DISTRIBUTION_THRESHOLD` mentees — the simple
 *     count carries enough shape on small lists.
 *   - Only one non-empty bucket — "8 mentees — 8 PhD" is tautological
 *     noise. The distribution exists to show *split*, not affirm uniformity.
 *
 *  Buckets render in fixed order (MD, PhD, MD-PhD, Postdoc, ECR, other);
 *  zero-count buckets are omitted so the line stays compact.
 */
export function formatMentoringDistribution(
  mentees: { programType: string | null }[],
): string | null {
  if (mentees.length < MENTORING_DISTRIBUTION_THRESHOLD) return null;

  const counts = new Map<MentoringDistributionBucket, number>();
  for (const m of mentees) {
    const bucket = mentoringDistributionBucket(m.programType);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const present = DISTRIBUTION_BUCKET_ORDER.filter((b) => (counts.get(b) ?? 0) > 0);
  if (present.length < 2) return null;

  return present.map((b) => `${counts.get(b)} ${b}`).join(" · ");
}
