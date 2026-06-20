-- CreateTable
CREATE TABLE `biosketch_generation` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `mode` VARCHAR(32) NOT NULL,
    `entries` JSON NOT NULL,
    `project_title` VARCHAR(300) NULL,
    `project_aims` TEXT NULL,
    `model` VARCHAR(64) NOT NULL,
    `prompt_version` VARCHAR(32) NULL,
    `params` JSON NOT NULL,
    `created_by_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `biosketch_generation_cwid_created_at_idx`(`cwid`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `biosketch_generation` ADD CONSTRAINT `biosketch_generation_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
