-- AlterTable
-- The ED/SOR degree string, kept beside `postnominal` so a scholar's degree pick
-- (field_override "postnominal") can be cleared back to it without waiting for
-- the nightly ED ETL. Backfilled from `postnominal`, which is exact: no degree
-- picks exist before this migration. Additive.
ALTER TABLE `scholar` ADD COLUMN `directory_postnominal` VARCHAR(64) NULL;

UPDATE `scholar` SET `directory_postnominal` = `postnominal`;
