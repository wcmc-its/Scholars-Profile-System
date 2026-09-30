-- Mentored publications report (/edit/reports/7) — data-driven per-report
-- access grants. One row = (report_key, scope_key, cwid): the holder may open
-- `report_key` and sees the program bucket `scope_key` ('*' = every scope).
-- Superuser / comms_steward never need a row; an EMPTY table means nobody else
-- can open the report (fail closed, no env flag). Managed in-app from the
-- report's "Viewers" panel (app/api/edit/report-access), audited as
-- report_access_grant / report_access_revoke.

CREATE TABLE `report_access` (
    `report_key` VARCHAR(64) NOT NULL,
    `scope_key` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `granted_by` VARCHAR(32) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `report_access_cwid_idx`(`cwid`),
    PRIMARY KEY (`report_key`, `scope_key`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- The learner's program ENTRY year, threaded through the mentoring bridge from
-- reciterdb.reporting_students_mentors.studentEntryYear (nullable at the
-- source). Additive + nullable; the report falls back to graduation_year - 4
-- until the next aoc-mentees import populates it.
ALTER TABLE `aoc_mentee`
  ADD COLUMN `entry_year` INTEGER NULL;
