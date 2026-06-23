/**
 * GrantRecs Phase 2 — map a scholar to one of the 5 career-stage buckets that an
 * opportunity's `appeal_by_stage` is keyed on (spec §7.5). Pure + clock-injected.
 *
 * Primary signal is `roleCategory`; full-time faculty are split early/mid/senior
 * by appointment tenure (fallback: years since terminal degree). Hidden classes
 * (`doctoral_student*`, `affiliate_alumni`) are still bucketed here for matching
 * even though they're suppressed on public surfaces — the forward matcher may run
 * for them in an authenticated context.
 *
 * Note: the ED ETL writes SUFFIXED student roles (`doctoral_student_md/_phd/
 * _mdphd`), so `doctoral_student` is matched by PREFIX, mirroring
 * `isPubliclyDisplayed` in `lib/eligibility.ts`.
 */

export type CareerStage = "grad" | "postdoc" | "early" | "mid" | "senior";

export type CareerStageInput = {
  roleCategory: string | null | undefined;
  appointments?: ReadonlyArray<{ startDate: Date | null }>;
  educations?: ReadonlyArray<{ year: number | null }>;
};

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

// Faculty seniority thresholds (tunable knobs).
const TENURE_EARLY_MAX_YEARS = 7; // appointment tenure < 7yr → early
const TENURE_SENIOR_MIN_YEARS = 20; // appointment tenure > 20yr → senior
/** Years-since-degree < this → early; also the NIH ESI window (10yr). Exported for the grant-history ESI check. */
export const DEGREE_EARLY_MAX_YEARS = 10;
const DEGREE_SENIOR_MIN_YEARS = 25; // years-since-degree > 25yr → senior

/** Earliest (most senior) non-null appointment start, in years before `now`. */
function appointmentTenureYears(input: CareerStageInput, now: Date): number | null {
  const starts = (input.appointments ?? [])
    .map((a) => a.startDate)
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (starts.length === 0) return null;
  const earliest = starts.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  return (now.getTime() - earliest.getTime()) / MS_PER_YEAR;
}

/** Years since the terminal (most recent) degree year, if any. */
export function yearsSinceTerminalDegree(input: CareerStageInput, now: Date): number | null {
  const years = (input.educations ?? [])
    .map((e) => e.year)
    .filter((y): y is number => typeof y === "number" && Number.isFinite(y));
  if (years.length === 0) return null;
  const terminal = Math.max(...years);
  return now.getFullYear() - terminal;
}

/** Split a full-time faculty member into early/mid/senior; default mid when undateable. */
function facultyStage(input: CareerStageInput, now: Date): CareerStage {
  const tenure = appointmentTenureYears(input, now);
  if (tenure !== null) {
    if (tenure < TENURE_EARLY_MAX_YEARS) return "early";
    if (tenure > TENURE_SENIOR_MIN_YEARS) return "senior";
    return "mid";
  }
  const sinceDegree = yearsSinceTerminalDegree(input, now);
  if (sinceDegree !== null) {
    if (sinceDegree < DEGREE_EARLY_MAX_YEARS) return "early";
    if (sinceDegree > DEGREE_SENIOR_MIN_YEARS) return "senior";
    return "mid";
  }
  return "mid";
}

export function careerStageBucket(input: CareerStageInput, now: Date = new Date()): CareerStage {
  const role = (input.roleCategory ?? "").toString();

  // Prefix family — ED writes doctoral_student_md / _phd / _mdphd.
  if (role.startsWith("doctoral_student")) return "grad";

  switch (role) {
    case "postdoc":
    case "fellow":
      return "postdoc";
    case "instructor":
    case "non_faculty_academic":
      return "early";
    case "affiliated_faculty":
    case "lecturer":
      return "mid";
    case "emeritus":
      return "senior";
    case "full_time_faculty":
      return facultyStage(input, now);
    default:
      // affiliate_alumni, non_academic, unknown/null → neutral default.
      return "mid";
  }
}
