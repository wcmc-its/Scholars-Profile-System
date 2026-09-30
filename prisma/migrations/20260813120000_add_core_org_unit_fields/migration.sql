-- Cores-as-org-units P1 (core-as-org-unit-plan.md). `core` gains manually
-- owned description/URL/visibility columns, and a new `core_leader` table
-- mirrors `center_program_leader` for co-led cores.
--
-- Additive-only, no backfill: all-new/defaulted columns and a brand-new
-- table, so the 13 existing cores land with `description`/`url` NULL,
-- `visible` false, and zero leaders — matches "default off" exactly.

-- AlterTable
ALTER TABLE `core` ADD COLUMN `description` TEXT NULL,
    ADD COLUMN `url` VARCHAR(512) NULL,
    ADD COLUMN `visible` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `core_leader` (
    `core_id` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `role` VARCHAR(32) NOT NULL DEFAULT 'director',
    `interim` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    INDEX `core_leader_core_id_idx`(`core_id`),
    PRIMARY KEY (`core_id`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `core_leader` ADD CONSTRAINT `core_leader_core_id_fkey` FOREIGN KEY (`core_id`) REFERENCES `core`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
