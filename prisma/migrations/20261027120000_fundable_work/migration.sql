-- WCM conference abstracts and preprints scored for private-funding potential
-- (etl/fundable-work, read by /edit/fundable-work). Additive DDL only.

-- CreateTable
CREATE TABLE `fundable_work` (
    `id` VARCHAR(32) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `doi` VARCHAR(255) NULL,
    `title` VARCHAR(1000) NOT NULL,
    `abstract` TEXT NOT NULL,
    `venue` VARCHAR(255) NULL,
    `publication_date` DATE NOT NULL,
    `score` INTEGER NOT NULL,
    `stage` VARCHAR(16) NOT NULL,
    `modality` VARCHAR(255) NULL,
    `rationale` TEXT NOT NULL,
    `pitch` TEXT NOT NULL,
    `funders` JSON NOT NULL,
    `model` VARCHAR(128) NOT NULL,
    `scored_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `fundable_work_score_idx`(`score`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fundable_work_author` (
    `work_id` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `position` VARCHAR(8) NOT NULL,

    INDEX `fundable_work_author_cwid_idx`(`cwid`),
    PRIMARY KEY (`work_id`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `fundable_work_author` ADD CONSTRAINT `fundable_work_author_work_id_fkey` FOREIGN KEY (`work_id`) REFERENCES `fundable_work`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fundable_work_author` ADD CONSTRAINT `fundable_work_author_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
