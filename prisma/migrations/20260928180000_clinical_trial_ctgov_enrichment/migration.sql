-- ClinicalTrials.gov enrichment: store the CT.gov overall status, start and
-- primary completion dates (as CT.gov gives them, "YYYY-MM" or "YYYY-MM-DD",
-- with their ACTUAL/ESTIMATED type), the hasResults flag, and interventions,
-- for the trial search UI. All columns are nullable: rows keep NULL until the
-- next clinical-trials ETL run, and trials CT.gov could not be read for stay
-- NULL. Additive DDL only; the running app image never selects these columns
-- by name.

-- AlterTable
ALTER TABLE `clinical_trial` ADD COLUMN `ctgov_status` VARCHAR(32) NULL,
    ADD COLUMN `start_date` VARCHAR(10) NULL,
    ADD COLUMN `start_date_type` VARCHAR(16) NULL,
    ADD COLUMN `primary_completion_date` VARCHAR(10) NULL,
    ADD COLUMN `primary_completion_date_type` VARCHAR(16) NULL,
    ADD COLUMN `has_results` BOOLEAN NULL,
    ADD COLUMN `intervention_types` TEXT NULL,
    ADD COLUMN `interventions` TEXT NULL;
