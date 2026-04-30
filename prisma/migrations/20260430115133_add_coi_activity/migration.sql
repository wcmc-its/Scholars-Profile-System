-- CreateTable
CREATE TABLE `coi_activity` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `entity` VARCHAR(255) NULL,
    `activity_type` VARCHAR(255) NULL,
    `value` VARCHAR(64) NULL,
    `activity_relates_to` VARCHAR(64) NULL,
    `wcmc_facilities` VARCHAR(8) NULL,
    `purchasing_procurement` VARCHAR(8) NULL,
    `chair_approval` VARCHAR(64) NULL,
    `activity_group` VARCHAR(128) NULL,
    `description` TEXT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'COI',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `coi_activity_cwid_idx`(`cwid`),
    INDEX `coi_activity_cwid_activity_group_idx`(`cwid`, `activity_group`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `coi_activity` ADD CONSTRAINT `coi_activity_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
