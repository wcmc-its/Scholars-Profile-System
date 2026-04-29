-- CreateTable
CREATE TABLE `scholar` (
    `cwid` VARCHAR(32) NOT NULL,
    `preferred_name` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(255) NOT NULL,
    `primary_title` VARCHAR(255) NULL,
    `primary_department` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `headshot_url` VARCHAR(512) NULL,
    `overview` TEXT NULL,
    `overview_updated_at` DATETIME(3) NULL,
    `slug` VARCHAR(255) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `scholar_slug_key`(`slug`),
    INDEX `scholar_deleted_at_idx`(`deleted_at`),
    INDEX `scholar_status_idx`(`status`),
    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointment` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `organization` VARCHAR(255) NOT NULL,
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `is_interim` BOOLEAN NOT NULL DEFAULT false,
    `external_id` VARCHAR(128) NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `appointment_cwid_idx`(`cwid`),
    INDEX `appointment_cwid_is_primary_end_date_idx`(`cwid`, `is_primary`, `end_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `education` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `degree` VARCHAR(255) NOT NULL,
    `institution` VARCHAR(255) NOT NULL,
    `year` INTEGER NULL,
    `field` VARCHAR(255) NULL,
    `external_id` VARCHAR(128) NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ASMS',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `education_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grant` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `title` TEXT NOT NULL,
    `role` VARCHAR(64) NOT NULL,
    `funder` VARCHAR(255) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `external_id` VARCHAR(128) NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'InfoEd',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `grant_cwid_idx`(`cwid`),
    INDEX `grant_cwid_end_date_idx`(`cwid`, `end_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication` (
    `pmid` VARCHAR(32) NOT NULL,
    `title` TEXT NOT NULL,
    `journal` VARCHAR(512) NULL,
    `year` INTEGER NULL,
    `publication_type` VARCHAR(64) NULL,
    `citation_count` INTEGER NOT NULL DEFAULT 0,
    `date_added_to_entrez` DATE NULL,
    `doi` VARCHAR(255) NULL,
    `pubmed_url` VARCHAR(512) NULL,
    `mesh_terms` JSON NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ReCiter',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_year_idx`(`year`),
    INDEX `publication_date_added_to_entrez_idx`(`date_added_to_entrez`),
    PRIMARY KEY (`pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication_author` (
    `id` VARCHAR(64) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NULL,
    `external_name` VARCHAR(255) NULL,
    `position` INTEGER NOT NULL,
    `total_authors` INTEGER NOT NULL,
    `is_first` BOOLEAN NOT NULL DEFAULT false,
    `is_last` BOOLEAN NOT NULL DEFAULT false,
    `is_penultimate` BOOLEAN NOT NULL DEFAULT false,
    `is_confirmed` BOOLEAN NOT NULL DEFAULT true,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_author_cwid_idx`(`cwid`),
    INDEX `publication_author_pmid_idx`(`pmid`),
    INDEX `publication_author_cwid_is_confirmed_idx`(`cwid`, `is_confirmed`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `topic_assignment` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `topic` VARCHAR(255) NOT NULL,
    `score` DOUBLE NOT NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'ReCiterAI-DynamoDB',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `topic_assignment_cwid_idx`(`cwid`),
    UNIQUE INDEX `topic_assignment_cwid_topic_key`(`cwid`, `topic`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication_score` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `score` DOUBLE NOT NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'ReCiterAI-DynamoDB',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_score_cwid_idx`(`cwid`),
    INDEX `publication_score_pmid_idx`(`pmid`),
    UNIQUE INDEX `publication_score_cwid_pmid_key`(`cwid`, `pmid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cwid_alias` (
    `old_cwid` VARCHAR(32) NOT NULL,
    `current_cwid` VARCHAR(32) NOT NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'ed_replacement_cwid',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cwid_alias_current_cwid_idx`(`current_cwid`),
    PRIMARY KEY (`old_cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `slug_history` (
    `old_slug` VARCHAR(255) NOT NULL,
    `current_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `slug_history_current_cwid_idx`(`current_cwid`),
    PRIMARY KEY (`old_slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `etl_run` (
    `id` VARCHAR(64) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `status` VARCHAR(16) NOT NULL,
    `rows_processed` INTEGER NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,

    INDEX `etl_run_source_started_at_idx`(`source`, `started_at`),
    INDEX `etl_run_source_status_completed_at_idx`(`source`, `status`, `completed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `appointment` ADD CONSTRAINT `appointment_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `education` ADD CONSTRAINT `education_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grant` ADD CONSTRAINT `grant_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_author` ADD CONSTRAINT `publication_author_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_author` ADD CONSTRAINT `publication_author_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `topic_assignment` ADD CONSTRAINT `topic_assignment_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_score` ADD CONSTRAINT `publication_score_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_score` ADD CONSTRAINT `publication_score_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cwid_alias` ADD CONSTRAINT `cwid_alias_current_cwid_fkey` FOREIGN KEY (`current_cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `slug_history` ADD CONSTRAINT `slug_history_current_cwid_fkey` FOREIGN KEY (`current_cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
