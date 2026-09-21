-- AlterTable
-- When the PERSON confirmed `orcid` in SPS via the /edit confirm route. NULL when the value came
-- from the WCM Identity table (etl/identity). Provenance for /edit/orcid-coverage's confirmed
-- split and for the identity ETL's conflict rule (Identity wins a differing non-null iD and clears
-- this). Additive: existing rows stay NULL.
ALTER TABLE `scholar` ADD COLUMN `orcid_confirmed_at` DATETIME(3) NULL;

-- CreateTable
-- ORCID iDs a person said are NOT theirs: "Not me" on a suggested candidate, or Remove on the iD
-- that was on file. One row per (cwid, orcid); written by the /edit dismiss route, deleted by the
-- confirm route for the same pair. Excluded from suggestions on the Identifiers & Profiles card and
-- /edit/orcid-coverage (the orcid_candidate mirrors keep re-creating the pair, so the exclusion
-- lives here); etl/orcid-push nulls Identity.orcid when Identity still holds a dismissed iD.
-- Additive.
CREATE TABLE `orcid_dismissal` (
  `cwid` VARCHAR(32) NOT NULL,
  `orcid` VARCHAR(19) NOT NULL,
  `dismissed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`cwid`, `orcid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orcid_dismissal` ADD CONSTRAINT `orcid_dismissal_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
