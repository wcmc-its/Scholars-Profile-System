-- Report 26's scoped row set: one row per confirmed authorship of a research
-- article, every scholar, every year, with the year, the displayed stage
-- (NULL = none) and the author position. Rebuilt nightly in one transaction by
-- etl:translational-portfolio. No foreign keys: the reciter ETL can drop and
-- re-add a publication, and the next fill follows it. Empty until the first
-- fill. Nothing reads it yet.

-- CreateTable
CREATE TABLE `translational_portfolio_author_pub` (
    `cwid` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `year` INTEGER NOT NULL,
    `stage` VARCHAR(8) NULL,
    `is_first` BOOLEAN NOT NULL,
    `is_last` BOOLEAN NOT NULL,

    INDEX `translational_portfolio_author_pub_year_idx`(`year`, `stage`, `is_first`, `is_last`),
    PRIMARY KEY (`cwid`, `pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
