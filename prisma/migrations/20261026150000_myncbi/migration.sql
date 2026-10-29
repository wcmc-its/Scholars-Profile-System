-- Public MyNCBI bibliographies for the URLs on scholars' NIH biosketches. Additive
-- DDL only: new tables that nothing reads until the image that writes them ships
-- (etl/myncbi).

-- CreateTable
CREATE TABLE `myncbi_bibliography` (
    `cwid` VARCHAR(32) NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `status` VARCHAR(8) NOT NULL,
    `error` VARCHAR(255) NULL,
    `citation_count` INTEGER NOT NULL,
    `fetched_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `myncbi_citation` (
    `cwid` VARCHAR(32) NOT NULL,
    `citation_id` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NULL,
    `title` VARCHAR(1000) NOT NULL,
    `source` VARCHAR(255) NULL,
    `year` INTEGER NULL,

    INDEX `myncbi_citation_pmid_idx`(`pmid`),
    PRIMARY KEY (`cwid`, `citation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `myncbi_bibliography` ADD CONSTRAINT `myncbi_bibliography_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `myncbi_citation` ADD CONSTRAINT `myncbi_citation_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
