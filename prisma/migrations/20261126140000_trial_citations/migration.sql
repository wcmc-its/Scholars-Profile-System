-- ClinicalTrials.gov studies that list a WCM publication as a background
-- reference, stored as citing documents (`source` 'ctgov', `level` 'trial';
-- both columns are VARCHAR(16), so no column change for the new values).
--
-- `citing_document.details`: trial facts the table has no column for, as
-- `{ phase, sponsor, sponsorClass, status, studyType, startDate }`.
-- `publication_citing_document.evidence`: `{ "ownTrial": true }` when a
-- confirmed WCM author of the paper is an investigator on the citing trial.
-- `publication.trial_count`: distinct citing trials, less the authors' own.
-- All three are filled by etl:policy-citations (its trials pass and rollup) on
-- its next run; NULL / 0 until then. Nothing reads them yet.

-- AlterTable
ALTER TABLE `citing_document`
    ADD COLUMN `details` JSON NULL;

-- AlterTable
ALTER TABLE `publication_citing_document`
    ADD COLUMN `evidence` JSON NULL;

-- AlterTable
ALTER TABLE `publication`
    ADD COLUMN `trial_count` INTEGER NOT NULL DEFAULT 0;
