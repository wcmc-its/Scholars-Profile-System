-- Cores: SPS-curated core staff (Staff section of /edit/core/[coreId]).
--
-- `core_staff` holds the people who run a core's services, as its owner
-- maintains them. The full list mirrors to the shared ReciterAI DynamoDB
-- table at (CORE#{core_id}, STAFF) / `staff_cwids`
-- (lib/cores/staff-writeback.ts), which the engine reads nightly as likely
-- co-authors when matching publications to the core.
--
-- Hard delete (no soft-remove columns): the add/remove history lives in the
-- audit log. FK-cascades from `core`, the same as `core_leader`.
--
-- The audit log's `action` ENUM gains `core_staff_add`/`core_staff_remove` in
-- the same PR (scripts/sql/audit-log.sql, separate database, separate file);
-- `target_entity_type` already has `core`.

-- CreateTable
CREATE TABLE `core_staff` (
    `core_id` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `added_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `core_staff_core_id_idx`(`core_id`),
    PRIMARY KEY (`core_id`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `core_staff` ADD CONSTRAINT `core_staff_core_id_fkey` FOREIGN KEY (`core_id`) REFERENCES `core`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
