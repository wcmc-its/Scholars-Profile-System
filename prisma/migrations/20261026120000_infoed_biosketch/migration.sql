-- InfoEd NIH biosketch harvest. Additive DDL only: a new table that nothing reads
-- until the image that writes it ships (etl/infoed-biosketch).

-- CreateTable
CREATE TABLE `infoed_biosketch` (
    `cwid` VARCHAR(32) NOT NULL,
    `doc_version_id` VARCHAR(64) NOT NULL,
    `prop_no` VARCHAR(32) NOT NULL,
    `uploaded_at` DATETIME(3) NOT NULL,
    `format` VARCHAR(8) NOT NULL,
    `attributed_by` VARCHAR(8) NOT NULL,
    `orcid` VARCHAR(19) NULL,
    `personal_statement` TEXT NULL,
    `contributions` TEXT NULL,
    `honors` TEXT NULL,
    `myncbi_url` VARCHAR(512) NULL,
    `extracted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `infoed_biosketch_orcid_idx`(`orcid`),
    PRIMARY KEY (`cwid`, `doc_version_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `infoed_biosketch` ADD CONSTRAINT `infoed_biosketch_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
