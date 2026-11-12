-- Cross-campus duplicates report (report 22), step 1a of the Ithaca ORCID plan.
-- Additive only: a nullable column that etl/ed fills from ED weillCornellEduNetID,
-- and a new table that etl/identity-links full-replaces weekly. Nothing reads
-- either until the image that writes them ships.

-- AlterTable
ALTER TABLE `scholar` ADD COLUMN `netid` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `scholar_netid_idx` ON `scholar`(`netid`);

-- CreateTable
CREATE TABLE `scholar_identity_link` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cwid` VARCHAR(32) NOT NULL,
    `netid` VARCHAR(32) NOT NULL,
    `band` VARCHAR(16) NOT NULL,
    `signals` JSON NOT NULL,
    `cornell_name` VARCHAR(255) NULL,
    `cornell_department` VARCHAR(255) NULL,
    `cornell_title` VARCHAR(255) NULL,
    `computed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scholar_identity_link_band_idx`(`band`),
    INDEX `scholar_identity_link_netid_idx`(`netid`),
    UNIQUE INDEX `scholar_identity_link_cwid_netid_key`(`cwid`, `netid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scholar_identity_link` ADD CONSTRAINT `scholar_identity_link_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
