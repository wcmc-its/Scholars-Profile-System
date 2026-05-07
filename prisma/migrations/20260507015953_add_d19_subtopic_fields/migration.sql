-- Phase 8 Plan 1 — D-19 / D-05 / D-02 nullable column additions.
-- See .planning/phases/08-hierarchy-artifact-etl-d-19-subtopic-display-fields-from-s3/08-01-PLAN.md
--
-- Additive only — no DROP COLUMN, no DROP TABLE, no RENAME. All new columns
-- are NULLABLE per CONTEXT.md migration nullability strategy:
-- "lazy-backfill on first hierarchy ETL run; UI fallback `display_name ?? label`
-- makes any backfill window safe."
--
-- subtopic gains four UI/scoring fields populated by Wave 2 hierarchy ETL.
-- etl_run gains two short-circuit fields populated only by Hierarchy ETL runs
-- (other ETLs leave them NULL — sparse-population is intentional, no constraints).

-- AlterTable
ALTER TABLE `subtopic` ADD COLUMN `display_name` VARCHAR(255) NULL,
    ADD COLUMN `short_description` TEXT NULL,
    ADD COLUMN `activity_count` INTEGER NULL,
    ADD COLUMN `total_weight` DOUBLE NULL;

-- AlterTable
ALTER TABLE `etl_run` ADD COLUMN `manifest_sha256` VARCHAR(64) NULL,
    ADD COLUMN `manifest_taxonomy_version` VARCHAR(64) NULL;
