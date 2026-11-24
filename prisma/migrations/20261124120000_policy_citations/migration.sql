-- Guideline and policy citations: documents that cite WCM publications
-- (PubMed guidelines, consensus statements and systematic reviews; NCBI
-- Bookshelf health-authority documents), loaded by etl:policy-citations.

-- CreateTable
CREATE TABLE `citing_document` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(16) NOT NULL,
    `external_id` VARCHAR(32) NOT NULL,
    `title` TEXT NOT NULL,
    `year` INTEGER NULL,
    `url` VARCHAR(255) NOT NULL,
    `level` VARCHAR(16) NOT NULL,
    `issuing_body` VARCHAR(64) NULL,
    `dedup_key` VARCHAR(191) NOT NULL,

    INDEX `citing_document_level_idx`(`level`),
    UNIQUE INDEX `citing_document_source_external_id_key`(`source`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication_citing_document` (
    `pmid` VARCHAR(32) NOT NULL,
    `citing_document_id` INTEGER NOT NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_citing_document_citing_document_id_idx`(`citing_document_id`),
    PRIMARY KEY (`pmid`, `citing_document_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- Rollups so a publication row renders its badges without a join, plus the
-- rolling Bookshelf pass marker. Additive; the counts default to 0.
ALTER TABLE `publication`
    ADD COLUMN `authority_bodies` JSON NULL,
    ADD COLUMN `guideline_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `review_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `bookshelf_checked_at` DATETIME(3) NULL;

-- AddForeignKey
ALTER TABLE `publication_citing_document` ADD CONSTRAINT `publication_citing_document_citing_document_id_fkey` FOREIGN KEY (`citing_document_id`) REFERENCES `citing_document`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
