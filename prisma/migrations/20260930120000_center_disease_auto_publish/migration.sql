-- Auto-publish high-confidence disease inferences (Cancer Center roster).
--
-- `center.disease_auto_publish` is the per-center switch behind
-- `lib/cancer-center-disease-publish.ts`: when 1, a
-- `cancer_center_disease_assignment` row with `confidence = 'high'` and no
-- curator `cancer_center_disease_decision` counts as published and leaves the
-- review queue. Default ON (product decision 2026-09-30). The curator toggles
-- it on /edit/center/[code]?attr=roster via
-- `POST /api/edit/center/[code]/disease-auto-publish`, which writes a
-- `disease_auto_publish_set` audit row (scripts/sql/audit-log.sql widens the
-- `action` ENUM in the same PR; `target_entity_type` already has `center`).
--
-- Additive DDL only: one NOT NULL column with a default. The running app image
-- never selects it, so this can land ahead of the image that reads it.

-- AlterTable
ALTER TABLE `center` ADD COLUMN `disease_auto_publish` BOOLEAN NOT NULL DEFAULT true;
