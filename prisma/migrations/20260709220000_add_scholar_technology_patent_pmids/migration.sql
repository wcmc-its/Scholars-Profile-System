-- Additive. Both columns are populated by the next `etl:technologies` run.
--
-- `pmids` is NOT NULL to match the TechnologyRow contract (pmids: string[]),
-- but a JSON column cannot carry a literal DEFAULT, and the table already holds
-- rows in every env. So: add it nullable, backfill to an empty array, then
-- tighten. Splitting it this way keeps the migration safe on a populated table.
ALTER TABLE `scholar_technology` ADD COLUMN `patent_status` VARCHAR(64) NULL;
ALTER TABLE `scholar_technology` ADD COLUMN `pmids` JSON NULL;

UPDATE `scholar_technology` SET `pmids` = JSON_ARRAY() WHERE `pmids` IS NULL;

ALTER TABLE `scholar_technology` MODIFY COLUMN `pmids` JSON NOT NULL;
