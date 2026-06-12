-- #879 — generated per-family definition passthrough (A2 tools-a2-v3).
-- Additive, nullable, backwards-compatible: the column is added to a possibly-
-- populated `scholar_family` table with no default; the next full-replace ETL
-- (etl:scholar-tool) backfills it by joining the artifact's top-level families[]
-- by family_id. `definition` is render-only — never re-fed into any LLM.
-- AlterTable
ALTER TABLE `scholar_family` ADD COLUMN `definition` TEXT NULL,
    ADD COLUMN `definition_source` VARCHAR(32) NULL;
