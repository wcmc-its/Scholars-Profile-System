/**
 * Q6 (respondent context) inference from `Scholar.roleCategory`. Returns
 * the pre-selected `FeedbackRole` value when a session is present at
 * form-open time, else `null`. See `docs/feedback-badge-spec.md` §
 * "Q6 inference from roleCategory" for the locked mapping.
 *
 * Matching is case-insensitive: the column stores `UPPER_SNAKE_CASE`
 * from the ED ETL but tests + facets occasionally use
 * `lower_snake_case`. The sets below normalize both via `.toLowerCase()`
 * at the call site.
 *
 * Unmapped values return `null` (e.g. an experimental new role-category
 * the ED ETL starts emitting) — the form opens with Q6 unselected, which
 * is the safe default.
 */
import { FeedbackRole } from "@/lib/generated/prisma/client";

const FACULTY: ReadonlySet<string> = new Set([
  "full_time_faculty",
  "affiliated_faculty",
  "voluntary_faculty",
  "adjunct_faculty",
  "courtesy_faculty",
  "faculty_emeritus",
  "instructor",
  "lecturer",
]);

const TRAINEE: ReadonlySet<string> = new Set([
  "postdoc",
  "fellow",
  "doctoral_student",
  "doctoral_student_md",
  "doctoral_student_phd",
  "doctoral_student_mdphd",
]);

const STAFF: ReadonlySet<string> = new Set([
  "research_staff",
  "non_faculty_academic",
  "non_academic",
]);

export function inferRoleFromCategory(
  roleCategory: string | null | undefined,
): FeedbackRole | null {
  if (!roleCategory) return null;
  const key = roleCategory.toLowerCase();
  if (FACULTY.has(key)) return FeedbackRole.wcm_faculty;
  if (TRAINEE.has(key)) return FeedbackRole.wcm_trainee;
  if (STAFF.has(key)) return FeedbackRole.wcm_staff;
  return null;
}
