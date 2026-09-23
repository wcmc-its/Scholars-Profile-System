/**
 * Display labels for `scholar.role_category`.
 *
 * Maps both UPPER_SNAKE_CASE (DB / ETL output) and lower_snake_case (test
 * fixtures and OpenSearch facet keys) to human-readable strings. The ONE
 * person-type vocabulary: `formatRoleCategory` and `roleCategoryLabel` both
 * read it, and differ only in what an UNMAPPED code shows (raw vs humanized).
 */
export const ROLE_DISPLAY: Record<string, string> = {
  FULL_TIME_FACULTY: "Full-time faculty",
  AFFILIATED_FACULTY: "Affiliated faculty",
  VOLUNTARY_FACULTY: "Voluntary faculty",
  ADJUNCT_FACULTY: "Adjunct faculty",
  COURTESY_FACULTY: "Courtesy faculty",
  FACULTY_EMERITUS: "Faculty emeritus",
  // #2211 — the value the ED ETL actually writes is bare `emeritus`; the
  // `FACULTY_EMERITUS`/`faculty_emeritus` keys are the older fixture spelling.
  // Both map to the same label so the department role-chip row (which groups on
  // the LABEL, not the code) keeps counting emeritus under "Affiliated faculty".
  EMERITUS: "Faculty emeritus",
  INSTRUCTOR: "Instructor",
  LECTURER: "Lecturer",
  POSTDOC: "Postdoc",
  FELLOW: "Fellow",
  RESEARCH_STAFF: "Research staff",
  DOCTORAL_STUDENT: "Doctoral student",
  DOCTORAL_STUDENT_MD: "MD student",
  DOCTORAL_STUDENT_PHD: "PhD student",
  DOCTORAL_STUDENT_MDPHD: "MD-PhD student",
  NON_FACULTY_ACADEMIC: "Non-faculty academic",
  NON_ACADEMIC: "Non-academic",
  AFFILIATE_ALUMNI: "Affiliate alumni",
  full_time_faculty: "Full-time faculty",
  affiliated_faculty: "Affiliated faculty",
  voluntary_faculty: "Voluntary faculty",
  adjunct_faculty: "Adjunct faculty",
  courtesy_faculty: "Courtesy faculty",
  faculty_emeritus: "Faculty emeritus",
  emeritus: "Faculty emeritus",
  instructor: "Instructor",
  lecturer: "Lecturer",
  postdoc: "Postdoc",
  fellow: "Fellow",
  research_staff: "Research staff",
  doctoral_student: "Doctoral student",
  doctoral_student_md: "MD student",
  doctoral_student_phd: "PhD student",
  doctoral_student_mdphd: "MD-PhD student",
  non_faculty_academic: "Non-faculty academic",
  non_academic: "Non-academic",
  affiliate_alumni: "Affiliate alumni",
};

export function formatRoleCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return ROLE_DISPLAY[raw] ?? raw;
}

/** Person types in descending career stage, keyed by display LABEL (both raw
 *  spellings share one label). Unlisted labels sort last, A–Z. */
export const CAREER_STAGE_ORDER: readonly string[] = [
  "Full-time faculty",
  "Affiliated faculty",
  "Voluntary faculty",
  "Adjunct faculty",
  "Courtesy faculty",
  "Instructor",
  "Lecturer",
  "Postdoc",
  "Fellow",
  "Research staff",
  "Doctoral student",
  "MD-PhD student",
  "MD student",
  "PhD student",
  "Faculty emeritus",
  "Non-faculty academic",
  "Non-academic",
  "Affiliate alumni",
];
const careerRank = (label: string) => {
  const i = CAREER_STAGE_ORDER.indexOf(label);
  return i === -1 ? CAREER_STAGE_ORDER.length : i;
};

/** Sort comparator for person-type options (`{ label }`): career stage, then A–Z.
 *  The Profiles / report 8 / ORCID facets (`loadDataQualityFacets`) and report 3's
 *  client-side rail share it. */
export const byCareerStage = (a: { label: string }, b: { label: string }): number =>
  careerRank(a.label) - careerRank(b.label) || a.label.localeCompare(b.label);

/**
 * Human label for an ED person-type code: `ROLE_DISPLAY`, else the code
 * HUMANIZED (`some_new_role` → "Some new role"), never dropped — ED owns the
 * vocabulary and can extend it without asking us, and a label that hid every
 * scholar carrying a new code would be worse than an imperfect one. Empty
 * string for absent: the caller decides what absence means (the Matcha facet
 * leaves such a candidate out rather than inventing a bucket).
 */
export function roleCategoryLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  const known = ROLE_DISPLAY[raw];
  if (known) return known;
  const humanized = raw.replace(/_/g, " ").trim();
  return humanized ? humanized.charAt(0).toUpperCase() + humanized.slice(1) : "";
}
