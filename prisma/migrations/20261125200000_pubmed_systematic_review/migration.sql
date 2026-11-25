-- Publications that PubMed's own systematic review filter matches, refreshed
-- weekly by etl:pubmed-systematic-reviews. Holds only the PMIDs flagged now.
-- No foreign key to publication: the reciter ETL can drop and re-add a row.

-- CreateTable
CREATE TABLE `pubmed_systematic_review` (
    `pmid` VARCHAR(32) NOT NULL,
    `flagged_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
