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
 *  from the bare "N mentees" subhead to a degree-bucket distribution.
 *  Defined as a named constant so the eventual recalibration after measuring
 *  real scholar distributions changes one line, not several.
 *
 *  Coincides with `MENTORING_GROUPED_THRESHOLD` today, but they are kept
 *  independent because they answer different questions and may diverge:
 *  one controls a subhead string, the other a layout switch. */
export const MENTORING_DISTRIBUTION_THRESHOLD = 8;

/** Issue #201 (Slice B) — at or above this mentee count, the chip grid
 *  switches from a single flat grid to per-degree-bucket subgroups, each
 *  with an `"<Bucket> · <count>"` header. The PhD bucket spans every PhD
 *  program (Neuroscience, Pharmacology, …); per-program detail remains on
 *  each chip subtitle, not in the group header. */
export const MENTORING_GROUPED_THRESHOLD = 8;

/** Issue #201 (Slice B2) — at or above this mentee count, the section
 *  header renders a sort selector and the grid truncates to
 *  `MENTORING_TRUNCATE_LIMIT` chips with an inline "Show all N →"
 *  affordance. Referenced in Slice B2 (truncation + sort gating); defined
 *  here in B1 so the multi-slice plan is visible at the point anyone
 *  touches this module between releases. */
export const MENTORING_TRUNCATE_THRESHOLD = 12;

/** Issue #201 (Slice B2) — top-N chips visible before the "Show all N →"
 *  affordance appears. Same value as `MENTORING_TRUNCATE_THRESHOLD` today
 *  but conceptually distinct: the threshold gates *whether* truncation
 *  applies, the limit determines *how many* survive truncation. Referenced
 *  in Slice B2. */
export const MENTORING_TRUNCATE_LIMIT = 12;

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

/** Single "terminal year" for sort tiebreaking across mixed mentee types
 *  (issue #183). Graduation year for AOC/PhD mentees; appointment end
 *  year for postdocs, with active postdocs (endYear=null) pinned to the
 *  top via MAX_SAFE_INTEGER. Mirrors the helper inside `getMenteesForMentor`
 *  in `lib/api/mentoring.ts`; lifted here so the grouped-tier (Slice B)
 *  re-sort in `mentoring-section.tsx` can share the same logic without
 *  pulling a server-only module into the client bundle. */
export function menteeTerminalYear(c: {
  graduationYear: number | null;
  appointmentRange: { startYear: number; endYear: number | null } | null;
}): number {
  if (c.graduationYear) return c.graduationYear;
  if (c.appointmentRange) {
    return c.appointmentRange.endYear ?? Number.MAX_SAFE_INTEGER;
  }
  return 0;
}

/** Issue #201 (Slice B1) — partition mentees into degree-bucket groups
 *  for the grouped chip grid at N ≥ `MENTORING_GROUPED_THRESHOLD`.
 *
 *  Buckets are returned in fixed order (MD → PhD → MD-PhD → Postdoc →
 *  ECR → Other); empty buckets are omitted entirely so the rendered
 *  output has no "Postdoc · 0" headers. Within each bucket the input
 *  order is preserved — callers are responsible for sorting `mentees`
 *  in the desired within-group order before partitioning (per §4.2 of
 *  SPEC-issue-201-slice-b.md, that's terminal-year desc, then name).
 *
 *  Generic over `T extends { programType: string | null }` so this
 *  partition helper isn't coupled to `MenteeChip` and is trivially
 *  testable with bare bucket objects.
 */
export function partitionMenteesByBucket<T extends { programType: string | null }>(
  mentees: T[],
): Array<{ bucket: MentoringDistributionBucket; mentees: T[] }> {
  const byBucket = new Map<MentoringDistributionBucket, T[]>();
  for (const m of mentees) {
    const bucket = mentoringDistributionBucket(m.programType);
    const existing = byBucket.get(bucket);
    if (existing) existing.push(m);
    else byBucket.set(bucket, [m]);
  }
  const out: Array<{ bucket: MentoringDistributionBucket; mentees: T[] }> = [];
  for (const bucket of DISTRIBUTION_BUCKET_ORDER) {
    const group = byBucket.get(bucket);
    if (group && group.length > 0) out.push({ bucket, mentees: group });
  }
  return out;
}
