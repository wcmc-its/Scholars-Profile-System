-- Clinical trials as a new profile data source.
--
-- Spine: reciterdb.clinical_trials (institutional CTMS export — carries cwid and
-- the always-present protocolNumber). Enrichment: reciterdb.clinical_trials_enriched
-- (a ClinicalTrials.gov API v2 pull), joined on nctNumber when present. The
-- `enrichment_source` / `enriched_at` columns record where the detail came from so
-- a fresher third-party feed can later replace NCT without touching the cwid spine
-- (`person_clinical_trial`) or the UI. Populated by `npm run etl:clinical-trials`.
--
-- Additive: two new tables FK-cascaded to scholar; no change to existing tables.
-- The profile section reads them only when CLINICAL_TRIALS_SECTION=on, so the
-- tables sit empty-and-dark until both the ETL backfill and the flag flip land.

-- CreateTable
CREATE TABLE `clinical_trial` (
    `protocol_number` VARCHAR(64) NOT NULL,
    `nct_number` VARCHAR(32) NULL,
    `title` TEXT NOT NULL,
    `status` VARCHAR(128) NULL,
    `status_date` DATE NULL,
    `protocol_type` VARCHAR(64) NULL,
    `study_type` VARCHAR(64) NULL,
    `phase` VARCHAR(64) NULL,
    `principal_sponsor` VARCHAR(255) NULL,
    `conditions` TEXT NULL,
    `mesh_terms` TEXT NULL,
    `brief_summary` TEXT NULL,
    `enrollment` INTEGER NULL,
    `first_ota_date` DATE NULL,
    `first_cta_date` DATE NULL,
    `enrichment_source` VARCHAR(48) NULL,
    `enriched_at` DATETIME(3) NULL,
    `source` VARCHAR(48) NOT NULL DEFAULT 'reciterdb.clinical_trials',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `clinical_trial_nct_number_key`(`nct_number`),
    PRIMARY KEY (`protocol_number`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `person_clinical_trial` (
    `cwid` VARCHAR(32) NOT NULL,
    `protocol_number` VARCHAR(64) NOT NULL,
    `role` VARCHAR(48) NOT NULL,
    `pi_name_raw` VARCHAR(255) NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `person_clinical_trial_cwid_idx`(`cwid`),
    INDEX `person_clinical_trial_protocol_number_idx`(`protocol_number`),
    PRIMARY KEY (`cwid`, `protocol_number`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `person_clinical_trial` ADD CONSTRAINT `person_clinical_trial_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `person_clinical_trial` ADD CONSTRAINT `person_clinical_trial_protocol_number_fkey` FOREIGN KEY (`protocol_number`) REFERENCES `clinical_trial`(`protocol_number`) ON DELETE CASCADE ON UPDATE CASCADE;
