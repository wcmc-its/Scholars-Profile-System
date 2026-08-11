-- CreateTable
CREATE TABLE `center_collab_candidate` (
    `center_code` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `total_papers_post_cutoff` INTEGER NOT NULL,
    `collaborations_with_center` INTEGER NOT NULL,
    `cancer_related_papers` INTEGER NOT NULL,
    `is_current_member` BOOLEAN NOT NULL,
    `current_program_code` VARCHAR(16) NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `center_collab_candidate_center_code_collaborations_with_cent_idx`(`center_code`, `collaborations_with_center`),
    INDEX `center_collab_candidate_center_code_cancer_related_papers_idx`(`center_code`, `cancer_related_papers`),
    PRIMARY KEY (`center_code`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `center_collab_candidate` ADD CONSTRAINT `center_collab_candidate_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;
