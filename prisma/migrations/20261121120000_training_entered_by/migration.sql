-- AlterTable
-- Scholar-entered postgraduate training rows (source SELF / CURATOR) record who
-- entered them. NULL for ASMS rows. Additive.
ALTER TABLE `training` ADD COLUMN `entered_by_cwid` VARCHAR(32) NULL;
