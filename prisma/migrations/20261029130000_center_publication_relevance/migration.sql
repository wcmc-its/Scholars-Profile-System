-- Per-center publication cancer relevance (etl/center-pub-relevance, reviewed on
-- the center's publication relevance report). Additive DDL only.

-- CreateTable
CREATE TABLE `center_publication_relevance` (
    `center_code` VARCHAR(64) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `relevant` BOOLEAN NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `reason` TEXT NULL,
    `model` VARCHAR(128) NULL,
    `prompt_hash` VARCHAR(12) NULL,
    `input_hash` VARCHAR(64) NULL,
    `inferred_at` DATETIME(3) NULL,
    `reviewed_by` VARCHAR(32) NULL,
    `reviewed_at` DATETIME(3) NULL,

    PRIMARY KEY (`center_code`, `pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `center_publication_relevance` ADD CONSTRAINT `center_publication_relevance_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;
