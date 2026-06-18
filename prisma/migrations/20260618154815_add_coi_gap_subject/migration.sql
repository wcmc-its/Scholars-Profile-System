-- #1112 — persist the per-mention grammatical subject of each COI-gap candidate so
-- the review redesign can mark self / co-author / unknown. Both nullable: existing
-- rows are backfilled on the next `etl:coi-gap` recompute (never guessed "self").
ALTER TABLE `coi_gap_candidate` ADD COLUMN `subject_type` VARCHAR(16) NULL;
ALTER TABLE `coi_gap_candidate` ADD COLUMN `subject_mention` VARCHAR(128) NULL;
