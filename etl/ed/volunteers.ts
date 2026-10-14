/**
 * Volunteers (and interns, whom ED records as volunteers) → the faculty member
 * they worked with, for `volunteer_mentor_relationship` (report 7's "Volunteer
 * or intern" type). The rule, decided 2026-10-14:
 *   - the record's `manager;sponsor` when that CWID is faculty, else its
 *     `manager;manager` when THAT is — a faculty sponsor or manager alone makes
 *     the pair (an administrator who sponsors makes none);
 *   - a record whose volunteer is faculty themselves is not a mentee;
 *   - a record naming no faculty member makes no row.
 * Pure, so the rule is testable without LDAP or a database.
 */
import type { EdVolunteerRoleRecord } from "@/lib/sources/ldap";

/** The role categories that count as faculty for a volunteer's sponsor or
 *  manager, and for "the volunteer is faculty themselves".
 *  ponytail: the faculty tiers by name; widen if a real sponsor population
 *  turns up outside them. */
export const VOLUNTEER_MENTOR_ROLES = [
  "full_time_faculty",
  "affiliated_faculty",
  "instructor",
  "lecturer",
  "emeritus",
] as const;

export type VolunteerPair = EdVolunteerRoleRecord & {
  mentorCwid: string;
  mentorRole: "sponsor" | "manager";
};

export function pairVolunteers(
  records: ReadonlyArray<EdVolunteerRoleRecord>,
  faculty: ReadonlySet<string>,
): { pairs: VolunteerPair[]; facultyVolunteers: number; noFacultyMentor: number } {
  const pairs: VolunteerPair[] = [];
  let facultyVolunteers = 0;
  let noFacultyMentor = 0;
  for (const r of records) {
    if (faculty.has(r.cwid)) {
      facultyVolunteers += 1;
      continue;
    }
    if (r.sponsorCwid && faculty.has(r.sponsorCwid)) {
      pairs.push({ ...r, mentorCwid: r.sponsorCwid, mentorRole: "sponsor" });
    } else if (r.managerCwid && faculty.has(r.managerCwid)) {
      pairs.push({ ...r, mentorCwid: r.managerCwid, mentorRole: "manager" });
    } else {
      noFacultyMentor += 1;
    }
  }
  return { pairs, facultyVolunteers, noFacultyMentor };
}
