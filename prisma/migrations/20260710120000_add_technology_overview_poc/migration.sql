-- Additive, nullable/defaulted — no backfill. Both columns stay empty on the
-- existing rows until the next `etl:technologies` run full-replaces the table
-- (that run is what scrapes CTL's "Technology Overview" section for the first
-- time). `overview` is TEXT because the section can run to a few thousand chars;
-- `has_poc_data` mirrors the schema default so a row inserted by an older ETL
-- image reads as "no PoC bullet" rather than NULL.
ALTER TABLE `scholar_technology` ADD COLUMN `overview` TEXT NULL;
ALTER TABLE `scholar_technology` ADD COLUMN `has_poc_data` BOOLEAN NOT NULL DEFAULT false;
