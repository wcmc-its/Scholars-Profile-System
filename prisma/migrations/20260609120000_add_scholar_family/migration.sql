-- CreateTable
CREATE TABLE `scholar_family` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `family_id` VARCHAR(64) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `supercategory` VARCHAR(128) NOT NULL,
    `pmid_count` INTEGER NOT NULL,
    `exemplar_tools` JSON NOT NULL,
    `source_artifact_sha` VARCHAR(64) NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scholar_family_cwid_pmid_count_idx`(`cwid`, `pmid_count` DESC),
    INDEX `scholar_family_supercategory_idx`(`supercategory`),
    UNIQUE INDEX `scholar_family_cwid_family_id_key`(`cwid`, `family_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scholar_family` ADD CONSTRAINT `scholar_family_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
