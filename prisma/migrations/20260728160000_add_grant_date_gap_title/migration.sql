-- #2020 — carry the InfoEd project title onto the undated-award worklist.
--
-- 74% of the rows in that worklist have no award number at all (measured
-- 2026-07-28: 1,862 of 2,519), so account number + sponsor + PI name was all
-- the recipient had to identify the record with. The title is the field that
-- makes it recognizable.
--
-- Nullable and no backfill: the ETL rewrites every gap row on each run, so the
-- column populates on the next `etl:infoed`. Existing rows read NULL until then.
ALTER TABLE `grant_date_gap` ADD COLUMN `title` TEXT NULL;
