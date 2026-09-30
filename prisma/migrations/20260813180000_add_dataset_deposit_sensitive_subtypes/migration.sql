-- Granular sensitive sub-typing (S-Index v2). Additive-only, no backfill
-- here: `scripts/bulk-data-rule/attribute.py`'s WRITE_DATASET_DEPOSIT path
-- (reciterdb side) populates these from taxonomy.py's tag(), and
-- `etl/data-sharing` full-replaces `dataset_deposit` from reciterdb on its
-- normal cadence, so an older app image simply never reads the new columns
-- until this lands.
-- AlterTable
ALTER TABLE `dataset_deposit` ADD COLUMN `sensitive_cats` VARCHAR(255) NULL,
    ADD COLUMN `sensitive_subtypes` VARCHAR(255) NULL;
