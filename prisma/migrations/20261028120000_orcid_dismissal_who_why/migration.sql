-- ORCID queue v3 B1. Additive DDL only: nullable columns on orcid_dismissal and
-- a new table. scripts/backfills/2026-10-28-orcid-dismissal-who-why.ts fills both.

-- AlterTable
ALTER TABLE `orcid_dismissal`
    ADD COLUMN `dismissed_by` VARCHAR(32) NULL,
    ADD COLUMN `reason` VARCHAR(32) NULL,
    ADD COLUMN `kept_orcid` VARCHAR(19) NULL;

-- CreateTable
CREATE TABLE `orcid_pair_seen` (
    `cwid` VARCHAR(32) NOT NULL,
    `orcid` VARCHAR(19) NOT NULL,
    `first_queued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`cwid`, `orcid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

