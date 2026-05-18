-- AlterTable
ALTER TABLE `grant` ADD COLUMN `keywords` JSON NULL,
    ADD COLUMN `keywords_fetched_at` DATETIME(3) NULL,
    ADD COLUMN `keywords_source` VARCHAR(32) NULL;
