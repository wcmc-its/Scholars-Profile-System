-- AlterTable
-- #2668 -- when Scholars first linked this authorship ("added to your profile"). Set once by
-- the column default on create and never touched by the reciter reconcile's UPDATE path, unlike
-- `last_refreshed_at`, which is the coi-gap watermark and moves on any content delta (position,
-- total_authors, is_confirmed) -- so the biosketch staleness nudge keyed on it counted a
-- metadata sweep as "publications added". Additive; the constant default makes the ADD COLUMN
-- metadata-only on MySQL 8 / Aurora.
ALTER TABLE `publication_author`
  ADD COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Backfill: the best available lower bound for rows that predate the column is their last
-- content change, which is never LATER than the true link time would be counted against a draft
-- created after this migration -- so no pre-existing authorship reads as "added" to a future
-- draft. Gated on the prod row count (#2668); under ~2M rows this is seconds inside the deploy's
-- migrate step, which runs before the new app rolls while the previous version keeps serving.
UPDATE `publication_author` SET `created_at` = `last_refreshed_at`;
