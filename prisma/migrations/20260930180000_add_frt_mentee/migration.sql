-- Faculty Review Tool self-reported mentees (etl/frt). New table only; the
-- running app image never reads it, so this can land ahead of the image.

-- CreateTable
CREATE TABLE `frt_mentee` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NULL,
    `mentee_name` VARCHAR(255) NOT NULL,
    `name_key` VARCHAR(255) NOT NULL,
    `mentoring_type` VARCHAR(255) NULL,
    `external` BOOLEAN NOT NULL DEFAULT false,
    `first_review_year` INTEGER NOT NULL,
    `last_review_year` INTEGER NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL,
    `dismissed_at` DATETIME(3) NULL,
    `dismissed_by` VARCHAR(32) NULL,

    INDEX `frt_mentee_mentee_cwid_idx`(`mentee_cwid`),
    UNIQUE INDEX `frt_mentee_mentor_cwid_name_key_key`(`mentor_cwid`, `name_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
