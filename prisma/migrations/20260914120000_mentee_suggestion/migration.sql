-- #2634 — co-authorship-derived mentee suggestions (queue rows for the mentor's
-- /edit "Mentees › From your publications" sub-view). Upserted nightly by
-- etl/reciter/mentee-suggestions.ts on (mentor_cwid, mentee_cwid); the
-- dismissed_* columns are owned by the edit surface and never touched by the ETL.

CREATE TABLE `mentee_suggestion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `mentee_name` VARCHAR(255) NOT NULL,
    `mentee_title` VARCHAR(255) NULL,
    `mentee_unit` VARCHAR(255) NULL,
    `kind` VARCHAR(24) NOT NULL,
    `tier` VARCHAR(16) NOT NULL,
    `n_co_pubs` INTEGER NOT NULL,
    `n_mentor_last_author` INTEGER NOT NULL,
    `n_mentee_first_author` INTEGER NOT NULL,
    `first_year` INTEGER NULL,
    `last_year` INTEGER NULL,
    `mentee_first_published_year` INTEGER NULL,
    `strong` BOOLEAN NOT NULL DEFAULT false,
    `evidence` JSON NOT NULL,
    `computed_at` DATETIME(3) NOT NULL,
    `dismissed_at` DATETIME(3) NULL,
    `dismissed_by` VARCHAR(32) NULL,
    `dismiss_reason` VARCHAR(24) NULL,

    UNIQUE INDEX `mentee_suggestion_mentor_cwid_mentee_cwid_key`(`mentor_cwid`, `mentee_cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
