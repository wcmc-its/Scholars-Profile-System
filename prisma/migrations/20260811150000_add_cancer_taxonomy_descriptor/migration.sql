-- CreateTable
CREATE TABLE `cancer_taxonomy_descriptor` (
    `descriptor_ui` VARCHAR(10) NOT NULL,
    `cancer_relevant` BOOLEAN NOT NULL,
    `topics` JSON NOT NULL,
    `admitted_by` JSON NOT NULL,
    `review_flags` JSON NOT NULL,
    `taxonomy_run_id` VARCHAR(64) NOT NULL,

    INDEX `cancer_taxonomy_descriptor_taxonomy_run_id_idx`(`taxonomy_run_id`),
    PRIMARY KEY (`descriptor_ui`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
