-- Backfill the missing CREATE TABLE for `division`.
--
-- Same root cause as 20260507125958_create_department: dev DBs have the
-- table from a prior `prisma db push`; CI on a fresh DB does not. There is
-- no later ALTER on `division` in migration history, so the columns here
-- match the current schema.prisma definition exactly.
--
-- IF NOT EXISTS makes this idempotent on existing dev DBs. The foreign key
-- to `department(code)` is intentionally deferred — adding it idempotently
-- against DBs where it already exists requires conditional DDL that's
-- awkward in a single migration file. A follow-up will reconcile FKs once
-- dev DBs are aligned or migrations are squashed to a fresh baseline.

-- CreateTable
CREATE TABLE IF NOT EXISTS `division` (
    `code` VARCHAR(64) NOT NULL,
    `dept_code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `chief_cwid` VARCHAR(32) NULL,
    `scholar_count` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED',
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `division_dept_code_idx`(`dept_code`),
    INDEX `division_slug_idx`(`slug`),
    UNIQUE INDEX `division_dept_code_slug_key`(`dept_code`, `slug`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
