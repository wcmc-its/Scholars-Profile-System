-- Honors-list scraper: a per-candidate evidence line on `honor`, and a per-list
-- run record for the queue's Sources tab (last run, on-list count, matches, new
-- candidates, error). Additive DDL only: one nullable column and one new table.
-- The running app image never selects either by name, so this can land ahead of
-- the image that reads them.

-- AlterTable
ALTER TABLE `honor` ADD COLUMN `evidence` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `honor_list_run` (
    `id` VARCHAR(64) NOT NULL,
    `list_id` VARCHAR(64) NOT NULL,
    `trigger` VARCHAR(16) NOT NULL,
    `requested_by_cwid` VARCHAR(32) NULL,
    `status` VARCHAR(16) NOT NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `on_list_total` INTEGER NULL,
    `matched` INTEGER NULL,
    `new_candidates` INTEGER NULL,
    `error_message` VARCHAR(1024) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `honor_list_run_list_id_created_at_idx`(`list_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
