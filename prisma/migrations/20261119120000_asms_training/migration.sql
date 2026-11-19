-- CreateTable
-- Postgraduate training from ASMS `fc_doctoral_training`, loaded by the ASMS ETL.
-- Additive; empty until the next ASMS run.
CREATE TABLE `training` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `institution` VARCHAR(255) NOT NULL,
    `specialty` VARCHAR(255) NULL,
    `year_from` INTEGER NULL,
    `year_to` INTEGER NULL,
    `external_id` VARCHAR(128) NOT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ASMS',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `training_external_id_key`(`external_id`),
    INDEX `training_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `training` ADD CONSTRAINT `training_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
