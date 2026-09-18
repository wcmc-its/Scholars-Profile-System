-- Mentored publications report (/edit/reports/7), round 2.

-- AlterTable
-- The mentor's name as the Medical Education roster carries it, threaded
-- through the mentoring bridge from reciterdb.reporting_students_mentors.
-- mentorFirstName / mentorLastName (nullable at the source). Additive +
-- nullable; the report shows a mentor with no Scholar row as "First Last"
-- instead of the bare CWID once the next aoc-mentees import populates it.
ALTER TABLE `aoc_mentee`
  ADD COLUMN `mentor_first_name` VARCHAR(255) NULL,
  ADD COLUMN `mentor_last_name` VARCHAR(255) NULL;

-- CreateTable
-- The learner's FULL ReCiter-attributed publication list (not just co-pubs
-- with a mentor), one row per (learner, pmid), `pub` = the same
-- CoPublicationFull JSON mentee_copublication_pub carries. Backs the report's
-- "All learner publications" mode. Exported WCM-side
-- (etl:mentoring:export-copubs -> mentoring/learner-pubs.ndjson) and loaded
-- in-VPC by etl:mentoring:import-learner-pubs. Empty until that import runs;
-- the report says so instead of rendering zeros.
CREATE TABLE `aoc_mentee_publication` (
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `pmid` INTEGER NOT NULL,
    `pub_year` INTEGER NULL,
    `pub` JSON NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `aoc_mentee_publication_mentee_cwid_idx`(`mentee_cwid`),
    PRIMARY KEY (`mentee_cwid`, `pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
