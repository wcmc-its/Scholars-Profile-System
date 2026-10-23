-- #3071 grant attribution showcase. Additive DDL only: two new tables that
-- nothing reads until the image that writes them ships (etl/reporter-grants,
-- /edit/grant-attribution-queue, report 14).

-- CreateTable
-- The scorer's latest verdict per judged RePORTER award, every band.
CREATE TABLE `grant_attribution_score` (
    `grant_external_id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `band` VARCHAR(8) NOT NULL,
    `score` INTEGER NOT NULL,
    `cues` JSON NOT NULL,
    `evidence_key` VARCHAR(255) NOT NULL,
    `award` JSON NOT NULL,
    `reporter_name` VARCHAR(255) NULL,
    `scored_at` DATETIME(3) NOT NULL,

    INDEX `grant_attribution_score_band_idx`(`band`),
    INDEX `grant_attribution_score_cwid_idx`(`cwid`),
    PRIMARY KEY (`grant_external_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- One row of totals per weekly scoring run.
CREATE TABLE `grant_attribution_run` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ran_at` DATETIME(3) NOT NULL,
    `scholars` INTEGER NOT NULL,
    `show` INTEGER NOT NULL,
    `hide` INTEGER NOT NULL,
    `queue` INTEGER NOT NULL,
    `recovered` INTEGER NOT NULL,
    `cues` JSON NOT NULL,

    INDEX `grant_attribution_run_ran_at_idx`(`ran_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `grant_attribution_score` ADD CONSTRAINT `grant_attribution_score_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
