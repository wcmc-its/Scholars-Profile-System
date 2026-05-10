-- Backfill the missing CREATE TABLE for `department`.
--
-- Same root cause as 20260507015952_create_subtopic: existing dev DBs have
-- the table from a prior `prisma db push`; CI on a fresh DB had no such
-- side door and the next ALTER (20260507130000_add_department_category)
-- failed with "Table 'scholars.department' doesn't exist."
--
-- Columns reflect the table state expected by the immediately-following
-- ALTER. The `category` column is intentionally omitted here — that's
-- exactly what the next migration adds.
--
-- IF NOT EXISTS makes this idempotent on existing dev DBs. The foreign-key
-- relationship from `division` to this table is established by the create
-- migration for division (which depends on this one running first).

-- CreateTable
CREATE TABLE IF NOT EXISTS `department` (
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `chair_cwid` VARCHAR(32) NULL,
    `scholar_count` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED',
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `department_slug_key`(`slug`),
    INDEX `department_slug_idx`(`slug`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
