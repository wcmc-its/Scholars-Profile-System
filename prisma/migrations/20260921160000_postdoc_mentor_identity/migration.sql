-- Mentored publications report (/edit/reports/7): a postdoc "mentor" (the ED
-- role record's manager) who is not a Scholar — a lab administrator, a
-- departed PI — showed as a bare CWID with no department or institution.

-- AlterTable
-- The manager as ou=people describes them at ETL time (etl/ed, #183 pass):
-- name, weillCornellEduPrimaryDepartment, primary-organization code.
-- Additive + nullable; filled by the next ED nightly.
ALTER TABLE `postdoc_mentor_relationship`
  ADD COLUMN `mentor_first_name` VARCHAR(64) NULL,
  ADD COLUMN `mentor_last_name` VARCHAR(64) NULL,
  ADD COLUMN `mentor_department` VARCHAR(255) NULL,
  ADD COLUMN `mentor_institution` VARCHAR(255) NULL;
