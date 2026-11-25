-- Citation fields on citing documents, so a guideline or report that cites a
-- WCM publication can be printed as a full reference (authors, journal, volume,
-- pages, DOI; publisher for NCBI Bookshelf documents). Filled by
-- etl:policy-citations; existing rows are back-filled on its next run.

-- AlterTable
ALTER TABLE `citing_document`
    ADD COLUMN `authors` TEXT NULL,
    ADD COLUMN `journal` VARCHAR(512) NULL,
    ADD COLUMN `journal_abbrev` VARCHAR(200) NULL,
    ADD COLUMN `volume` VARCHAR(64) NULL,
    ADD COLUMN `issue` VARCHAR(128) NULL,
    ADD COLUMN `pages` VARCHAR(128) NULL,
    ADD COLUMN `doi` VARCHAR(255) NULL,
    ADD COLUMN `publisher` VARCHAR(512) NULL;
