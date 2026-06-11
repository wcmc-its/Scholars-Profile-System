-- AlterTable
ALTER TABLE `family_suppression_overlay` ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'seed';

-- AlterTable
ALTER TABLE `family_sensitivity_overlay` ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'seed';

-- CreateTable
CREATE TABLE `family_review_flag` (
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `first_seen_at` DATETIME(3) NOT NULL,
    `last_seen_at` DATETIME(3) NOT NULL,
    `reviewed_at` DATETIME(3) NULL,
    `reviewed_by_cwid` VARCHAR(32) NULL,

    PRIMARY KEY (`supercategory`, `family_label`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

