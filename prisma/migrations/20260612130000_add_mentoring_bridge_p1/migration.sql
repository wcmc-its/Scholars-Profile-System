-- Issue #928 — bridge the two P1 request-time ReciterDB surfaces in
-- lib/api/mentoring.ts (AOC mentee list + full co-pub list) into Aurora, the
-- same way #926 bridged the co-pub count. Both read behind MENTORING_COPUB_BRIDGE.

-- AOC / med-student mentee bridge: raw mirror of ReciterDB
-- `reporting_students_mentors`. A (mentor, mentee) pair may appear under several
-- programs, so rows are not collapsed here (surrogate `id` PK + truncate-load).
CREATE TABLE `aoc_mentee` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `first_name` VARCHAR(255) NULL,
    `last_name` VARCHAR(255) NULL,
    `graduation_year` INTEGER NULL,
    `program_type` VARCHAR(64) NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    INDEX `aoc_mentee_mentor_cwid_idx` (`mentor_cwid`),
    INDEX `aoc_mentee_mentor_mentee_idx` (`mentor_cwid`, `mentee_cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Full co-pub list bridge: one row per (mentor, mentee, pmid). `pub` carries the
-- raw CoPublicationFull JSON (pre-suppression; the read path re-applies local
-- suppression). `pub_year` is denormalized for DB-side ordering.
CREATE TABLE `mentee_copublication_pub` (
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `pmid` INTEGER NOT NULL,
    `pub_year` INTEGER NULL,
    `pub` JSON NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`mentor_cwid`, `mentee_cwid`, `pmid`),
    INDEX `mentee_copublication_pub_pair_idx` (`mentor_cwid`, `mentee_cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
