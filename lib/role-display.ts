/**
 * Display labels for `scholar.role_category`.
 *
 * Maps both UPPER_SNAKE_CASE (DB / ETL output) and lower_snake_case (test
 * fixtures and OpenSearch facet keys) to human-readable strings. Falls back
 * to the raw value when unmapped so we never silently drop a category.
 */
export const ROLE_DISPLAY: Record<string, string> = {
  FULL_TIME_FACULTY: "Full-time faculty",
  AFFILIATED_FACULTY: "Affiliated faculty",
  VOLUNTARY_FACULTY: "Voluntary faculty",
  ADJUNCT_FACULTY: "Adjunct faculty",
  COURTESY_FACULTY: "Courtesy faculty",
  FACULTY_EMERITUS: "Faculty emeritus",
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
  full_time_faculty: "Full-time faculty",
  affiliated_faculty: "Affiliated faculty",
  voluntary_faculty: "Voluntary faculty",
  adjunct_faculty: "Adjunct faculty",
  courtesy_faculty: "Courtesy faculty",
  faculty_emeritus: "Faculty emeritus",
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
};

export function formatRoleCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return ROLE_DISPLAY[raw] ?? raw;
}
