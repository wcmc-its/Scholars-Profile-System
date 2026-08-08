-- CreateTable
CREATE TABLE `cancer_center_funding_award` (
    `id` VARCHAR(191) NOT NULL,
    `center_code` VARCHAR(64) NOT NULL,
    `reporting_cycle` VARCHAR(64) NOT NULL,
    `institution_number` INTEGER NOT NULL,
    `source_award_number` VARCHAR(128) NOT NULL,
    `grant_cwid` VARCHAR(32) NULL,
    `pi` VARCHAR(255) NOT NULL,
    `specific_funding_source` VARCHAR(255) NOT NULL,
    `project_number` VARCHAR(128) NOT NULL,
    `project_title` TEXT NOT NULL,
    `project_start_date` DATE NOT NULL,
    `project_end_date` DATE NOT NULL,
    `annual_project_direct_costs` DECIMAL(12, 2) NOT NULL,
    `cancer_relevant_percent` DECIMAL(5, 2) NULL,
    `cancer_relevant_percent_source` VARCHAR(16) NOT NULL DEFAULT 'llm',
    `cancer_relevant_rationale` TEXT NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `cancer_center_funding_award_center_code_reporting_cycle_idx`(`center_code`, `reporting_cycle`),
    INDEX `cancer_center_funding_award_grant_cwid_idx`(`grant_cwid`),
    UNIQUE INDEX `cancer_center_funding_award_center_code_reporting_cycle_inst_key`(`center_code`, `reporting_cycle`, `institution_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cancer_center_program_allocation` (
    `id` VARCHAR(191) NOT NULL,
    `award_id` VARCHAR(191) NOT NULL,
    `center_code` VARCHAR(64) NOT NULL,
    `program_code` VARCHAR(16) NULL,
    `program_percent` DECIMAL(5, 2) NOT NULL,
    `source` VARCHAR(16) NOT NULL DEFAULT 'membership',
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    INDEX `cancer_center_program_allocation_award_id_idx`(`award_id`),
    INDEX `cancer_center_program_allocation_center_code_program_code_idx`(`center_code`, `program_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cancer_center_funding_award` ADD CONSTRAINT `cancer_center_funding_award_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cancer_center_program_allocation` ADD CONSTRAINT `cancer_center_program_allocation_award_id_fkey` FOREIGN KEY (`award_id`) REFERENCES `cancer_center_funding_award`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cancer_center_program_allocation` ADD CONSTRAINT `cancer_center_program_allocation_center_code_program_code_fkey` FOREIGN KEY (`center_code`, `program_code`) REFERENCES `center_program`(`center_code`, `code`) ON DELETE NO ACTION ON UPDATE NO ACTION;
