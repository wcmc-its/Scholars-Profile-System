-- Citations between two publications in Scholars (`citing_pmid` cites
-- `cited_pmid`), from reciterdb `analysis_nih_cites`. Both ends are rows of
-- `publication`; a paper citing itself is left out. Loaded by
-- etl:citation-links and only ever added to. Keyed both ways round so either
-- direction is an index read. No foreign keys, like
-- `publication_citing_document`: the reciter ETL can drop and re-add a
-- publication. Empty until the first load. Nothing reads it yet.

-- CreateTable
CREATE TABLE `publication_citation` (
    `cited_pmid` VARCHAR(32) NOT NULL,
    `citing_pmid` VARCHAR(32) NOT NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_citation_citing_pmid_cited_pmid_idx`(`citing_pmid`, `cited_pmid`),
    PRIMARY KEY (`cited_pmid`, `citing_pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
