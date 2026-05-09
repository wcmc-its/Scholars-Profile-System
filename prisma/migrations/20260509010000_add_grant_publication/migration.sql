-- Materialized join between Grant and Publication, populated nightly by
-- etl/reporter/index.ts from reciterdb.grant_provenance. Drives pub counts
-- and the expanded pub list per grant in the Funding section (#86).

-- CreateTable
CREATE TABLE `grant_publication` (
    `id` VARCHAR(64) NOT NULL,
    `grant_id` VARCHAR(64) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `source_reporter` BOOLEAN NOT NULL DEFAULT false,
    `source_reciterdb` BOOLEAN NOT NULL DEFAULT false,
    `reporter_first_seen` DATETIME(3) NULL,
    `reciterdb_first_seen` DATETIME(3) NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `grant_publication_grant_id_pmid_key` (`grant_id`, `pmid`),
    INDEX `grant_publication_grant_id_idx` (`grant_id`),
    INDEX `grant_publication_pmid_idx` (`pmid`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `grant_publication` ADD CONSTRAINT `grant_publication_grant_id_fkey`
    FOREIGN KEY (`grant_id`) REFERENCES `grant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grant_publication` ADD CONSTRAINT `grant_publication_pmid_fkey`
    FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;
