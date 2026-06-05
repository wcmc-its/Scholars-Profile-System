-- CreateTable
CREATE TABLE `overview_generation` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `text` TEXT NOT NULL,
    `model` VARCHAR(64) NOT NULL,
    `params` JSON NOT NULL,
    `created_by_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `overview_generation_cwid_created_at_idx`(`cwid`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `overview_provenance` (
    `cwid` VARCHAR(32) NOT NULL,
    `origin` VARCHAR(24) NOT NULL,
    `model` VARCHAR(64) NULL,
    `source_generation_id` VARCHAR(64) NULL,
    `updated_by_cwid` VARCHAR(32) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `overview_generation` ADD CONSTRAINT `overview_generation_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `overview_provenance` ADD CONSTRAINT `overview_provenance_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

