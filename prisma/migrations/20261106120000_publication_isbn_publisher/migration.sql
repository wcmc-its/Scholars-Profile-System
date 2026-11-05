-- Book citation fields for external records (books added from Crossref / Scopus).
-- Sourced from reciterdb.external_article (ReCiterDB v3.5) by the reciter ETL;
-- NULL for every PubMed record.

-- AlterTable
ALTER TABLE `publication` ADD COLUMN `isbn` VARCHAR(128) NULL,
    ADD COLUMN `publisher` VARCHAR(255) NULL;
