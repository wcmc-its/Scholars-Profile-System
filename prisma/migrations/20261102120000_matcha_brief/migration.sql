-- Matcha Phase 3: per-PI briefs, and a rename for saved searches.
--
-- `matcha_brief` holds one brief per (paste, PI). It is keyed on the paste's
-- `description_hash` (the same digest as `sponsor_match_submission`), not on a
-- submission row, because every replay or Re-run writes a new submission row
-- and an edited brief must survive both. No FK for that reason (the hash is not
-- unique on the submission table); the route's DELETE of a paste removes its
-- briefs explicitly.
--
-- `generated` is the model's output after fact-check and post-check; `edited`
-- is the officer's version of any section (NULL = unedited); `note` is free
-- text that is never generated and never exported.
--
-- `sponsor_match_submission.title_override` is the officer's own name for a
-- search, kept apart from the generated `title` so clearing it restores the
-- original.
--
-- The audit log's `action` ENUM gains `matcha_brief_generate` and its
-- `target_entity_type` ENUM gains `matcha_ask` in the same PR
-- (scripts/sql/audit-log.sql, separate database, separate file).

-- CreateTable
CREATE TABLE `matcha_brief` (
    `id` VARCHAR(64) NOT NULL,
    `description_hash` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `generated` JSON NOT NULL,
    `edited` JSON NULL,
    `note` TEXT NULL,
    `model` VARCHAR(64) NOT NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `matcha_brief_description_hash_cwid_key`(`description_hash`, `cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `sponsor_match_submission`
    ADD COLUMN `title_override` VARCHAR(120) NULL;
