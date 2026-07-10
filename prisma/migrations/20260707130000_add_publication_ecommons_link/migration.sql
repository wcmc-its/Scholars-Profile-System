-- #1567 — eCommons institutional-repository handle URL per publication.
-- Populated by etl/reciter/index.ts from reciterdb.ecommons_pmid_link
-- (pmid → ecommonslink). Additive, nullable, no default; existing rows stay
-- untouched until the next ReCiter ETL run backfills the matched PMIDs. A
-- failed/absent crosswalk read leaves the column null and never fails the run.

-- AlterTable
ALTER TABLE `publication` ADD COLUMN `ecommons_link` VARCHAR(255) NULL;
