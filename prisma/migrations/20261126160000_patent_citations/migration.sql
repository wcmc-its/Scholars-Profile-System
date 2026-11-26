-- US patents that cite a WCM publication, from the Reliance on Science
-- dataset, stored as citing documents (`source` 'ros', `level` 'patent'; both
-- columns are VARCHAR(16), so no column change for the new values). Loaded by
-- etl:patent-citations:import from an extract file an operator uploads.
--
-- `citing_document.details`: `{ kind, grantDate, publicationDate, filingDate,
-- familyKey, familySize, assignees, inventors, metadataRelease }`, and
-- `dedup_key` is the family key, so documents of one invention count once.
-- `publication_citing_document.evidence`: `{ score, where, release }`, plus
-- `sharedId` when a tie-break decided which paper the link belongs to.
-- `publication.patent_family_count`: distinct inventions citing the paper.
-- 0 until the first load. Nothing reads it yet; the index is for a report's
-- "cited by a patent" filter (about 13% of rows).
-- `publication_openalex`: the OpenAlex work ids of a PubMed-keyed publication,
-- which is how the dataset names a paper. A paper can have two. No foreign
-- key, like the link table: the reciter ETL can drop and re-add a publication.

-- AlterTable
ALTER TABLE `publication`
    ADD COLUMN `patent_family_count` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX `publication_patent_family_count_idx` ON `publication`(`patent_family_count`);

-- CreateTable
CREATE TABLE `publication_openalex` (
    `pmid` VARCHAR(32) NOT NULL,
    `openalex_id` VARCHAR(32) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `checked_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_openalex_openalex_id_idx`(`openalex_id`),
    PRIMARY KEY (`pmid`, `openalex_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
