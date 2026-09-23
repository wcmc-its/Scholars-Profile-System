-- Overview History panel: name / hide a draft, and a log of every saved overview.

-- AlterTable
ALTER TABLE `overview_generation`
    ADD COLUMN `name` VARCHAR(40) NULL,
    ADD COLUMN `hidden_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `overview_version` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `html` TEXT NOT NULL,
    `origin` VARCHAR(24) NOT NULL,
    `source_generation_id` VARCHAR(64) NULL,
    `saved_by_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `hidden_at` DATETIME(3) NULL,

    INDEX `overview_version_cwid_created_at_idx`(`cwid`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `overview_version` ADD CONSTRAINT `overview_version_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
