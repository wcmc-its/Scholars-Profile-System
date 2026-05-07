-- Profile-page recovery — additive columns parked on feat/browse-redesign-wip,
-- now applied directly to master to restore the sidebar "Clinical profile →" link
-- and surface NIH-style award numbers in the Grants section.
--
-- Additive only — no DROP, no RENAME. Both columns nullable / defaulted so the
-- migration applies cleanly to existing rows; ED/InfoEd ETLs backfill on next run.

-- AlterTable
ALTER TABLE `scholar` ADD COLUMN `has_clinical_profile` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `grant` ADD COLUMN `award_number` VARCHAR(128) NULL;
