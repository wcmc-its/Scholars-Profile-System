-- Report 5 (Clinical Trials) sponsor type: a nullable sponsor-class key per
-- trial, filled by the clinical-trials ETL from ClinicalTrials.gov
-- LeadSponsorClass, else a best-effort read of OnCore's principal sponsor
-- (lib/clinical-trial-sponsor-class.ts). Null means unknown. Additive, DDL only.

-- AlterTable
ALTER TABLE `clinical_trial` ADD COLUMN `sponsor_class` VARCHAR(16) NULL;
