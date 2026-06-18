-- Per-program pages (#1105).
--
-- A center program (`center_program`, the #552 thin taxonomy) gains the fields
-- needed for a dedicated page modeled on a division page: a single program
-- LEADER (`leader_cwid` + the `leader_interim` qualifier, resolved either to a
-- WCM scholar or the external-leader fallback keyed `<center_code>:<code>`) and
-- a prose `description`. All three are manually owned (no ETL writes them) and
-- null/false until a curator sets them, so the page surface is dark-by-default
-- and additionally gated behind the off-by-default `CENTER_PROGRAM_PAGES` flag.
ALTER TABLE `center_program` ADD COLUMN `leader_cwid` VARCHAR(32) NULL;
ALTER TABLE `center_program` ADD COLUMN `leader_interim` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `center_program` ADD COLUMN `description` TEXT NULL;
