-- Dataset title/metadata enrichment (#2350 Phase 2). Additive-only, no
-- backfill here: `scripts/bulk-data-rule/enrich_titles.py` (reciterdb side)
-- populates these from DataCite (DOI-based repos) and ClinicalTrials.gov,
-- and `etl/data-sharing` full-replaces `dataset_deposit` from reciterdb on
-- its normal cadence, so an older app image simply never reads the new
-- columns until this lands.
-- AlterTable
ALTER TABLE `dataset_deposit` ADD COLUMN `title` VARCHAR(512) NULL,
    ADD COLUMN `description` TEXT NULL,
    ADD COLUMN `creators` JSON NULL,
    ADD COLUMN `publisher` VARCHAR(255) NULL,
    ADD COLUMN `trial_phase` VARCHAR(32) NULL,
    ADD COLUMN `trial_status` VARCHAR(32) NULL,
    ADD COLUMN `trial_conditions` JSON NULL;
