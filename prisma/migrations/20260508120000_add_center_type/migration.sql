-- Center.centerType — splits the Center model into two presentation kinds.
-- Institutes (typically larger, externally designated, often NCI/NIH-recognized)
-- get their own teal badge in the autocomplete; centers stay purple. Backfill
-- uses a name-contains heuristic ("Institute" anywhere in the name → institute);
-- subsequent renames or new rows can be corrected in seed data without another
-- migration.

-- AlterTable
ALTER TABLE `center` ADD COLUMN `center_type` VARCHAR(16) NOT NULL DEFAULT 'center';

-- Backfill institutes by name
UPDATE `center` SET `center_type` = 'institute' WHERE `name` LIKE '%Institute%';
