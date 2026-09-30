-- Mentored publications report (/edit/reports/7): mentor department and
-- institution columns.

-- AlterTable
-- The mentor's department and institution as the Medical Education roster
-- carries them, threaded through the mentoring bridge from
-- reciterdb.reporting_students_mentors.mentorDepartment / mentorInstitution
-- (free text, nullable at the source). Additive + nullable; empty until the
-- next aoc-mentees export + import.
ALTER TABLE `aoc_mentee`
  ADD COLUMN `mentor_department` VARCHAR(255) NULL,
  ADD COLUMN `mentor_institution` VARCHAR(255) NULL;
