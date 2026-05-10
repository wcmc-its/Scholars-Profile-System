-- Squashed initial schema (#134).
--
-- Replaces the previous 27-migration history that accumulated `db push`
-- artifacts (subtopic, department, division backfills) and two intentionally
-- deferred FKs (subtopic_parent_topic_id_fkey, division_dept_code_fkey).
-- Generated via `prisma migrate diff --from-empty --to-schema prisma/schema.prisma`
-- so the resulting database matches schema.prisma exactly. See PR for the
-- developer-facing re-baseline procedure.

-- CreateTable
CREATE TABLE `scholar` (
    `cwid` VARCHAR(32) NOT NULL,
    `preferred_name` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(255) NOT NULL,
    `postnominal` VARCHAR(64) NULL,
    `primary_title` VARCHAR(255) NULL,
    `primary_department` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `headshot_url` VARCHAR(512) NULL,
    `overview` TEXT NULL,
    `overview_updated_at` DATETIME(3) NULL,
    `slug` VARCHAR(255) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `role_category` VARCHAR(32) NULL,
    `dept_code` VARCHAR(64) NULL,
    `div_code` VARCHAR(64) NULL,
    `has_clinical_profile` BOOLEAN NOT NULL DEFAULT false,
    `postdoctoral_mentor_cwid` VARCHAR(32) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `scholar_slug_key`(`slug`),
    INDEX `scholar_deleted_at_idx`(`deleted_at`),
    INDEX `scholar_status_idx`(`status`),
    INDEX `scholar_role_category_idx`(`role_category`),
    INDEX `scholar_dept_code_idx`(`dept_code`),
    INDEX `scholar_div_code_idx`(`div_code`),
    INDEX `scholar_postdoctoral_mentor_cwid_idx`(`postdoctoral_mentor_cwid`),
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
CREATE TABLE `person_nih_profile` (
    `cwid` VARCHAR(32) NOT NULL,
    `nih_profile_id` INTEGER NOT NULL,
    `is_preferred` BOOLEAN NOT NULL DEFAULT false,
    `first_seen` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_verified` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `source` VARCHAR(32) NOT NULL DEFAULT 'RePORTER',
    `resolution_source` VARCHAR(32) NOT NULL,

    INDEX `person_nih_profile_cwid_is_preferred_idx`(`cwid`, `is_preferred`),
    PRIMARY KEY (`cwid`, `nih_profile_id`)
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
    `award_number` VARCHAR(128) NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'InfoEd',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `program_type` VARCHAR(64) NOT NULL DEFAULT 'Grant',
    `prime_sponsor` VARCHAR(64) NULL,
    `prime_sponsor_raw` VARCHAR(255) NULL,
    `direct_sponsor` VARCHAR(64) NULL,
    `direct_sponsor_raw` VARCHAR(255) NULL,
    `mechanism` VARCHAR(16) NULL,
    `nih_ic` VARCHAR(8) NULL,
    `is_subaward` BOOLEAN NOT NULL DEFAULT false,
    `appl_id` INTEGER NULL,
    `abstract` TEXT NULL,
    `abstract_fetched_at` DATETIME(3) NULL,
    `abstract_source` VARCHAR(32) NULL,

    INDEX `grant_cwid_idx`(`cwid`),
    INDEX `grant_cwid_end_date_idx`(`cwid`, `end_date`),
    INDEX `grant_prime_sponsor_idx`(`prime_sponsor`),
    INDEX `grant_program_type_idx`(`program_type`),
    INDEX `grant_appl_id_idx`(`appl_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication` (
    `pmid` VARCHAR(32) NOT NULL,
    `title` TEXT NOT NULL,
    `authors_string` VARCHAR(2000) NULL,
    `full_authors_string` TEXT NULL,
    `journal` VARCHAR(512) NULL,
    `year` INTEGER NULL,
    `publication_type` VARCHAR(64) NULL,
    `citation_count` INTEGER NOT NULL DEFAULT 0,
    `date_added_to_entrez` DATE NULL,
    `doi` VARCHAR(255) NULL,
    `pmcid` VARCHAR(32) NULL,
    `volume` VARCHAR(64) NULL,
    `issue` VARCHAR(128) NULL,
    `pages` VARCHAR(128) NULL,
    `journal_abbrev` VARCHAR(200) NULL,
    `pubmed_url` VARCHAR(512) NULL,
    `mesh_terms` JSON NULL,
    `abstract` TEXT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ReCiter',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `publication_year_idx`(`year`),
    INDEX `publication_date_added_to_entrez_idx`(`date_added_to_entrez`),
    PRIMARY KEY (`pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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

    INDEX `grant_publication_grant_id_idx`(`grant_id`),
    INDEX `grant_publication_pmid_idx`(`pmid`),
    UNIQUE INDEX `grant_publication_grant_id_pmid_key`(`grant_id`, `pmid`),
    PRIMARY KEY (`id`)
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
CREATE TABLE `topic` (
    `id` VARCHAR(128) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `source` VARCHAR(64) NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subtopic` (
    `id` VARCHAR(128) NOT NULL,
    `parent_topic_id` VARCHAR(128) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `display_name` VARCHAR(255) NULL,
    `short_description` TEXT NULL,
    `activity_count` INTEGER NULL,
    `total_weight` DOUBLE NULL,
    `source` VARCHAR(64) NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `subtopic_parent_topic_id_idx`(`parent_topic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `department` (
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `category` VARCHAR(32) NOT NULL DEFAULT 'clinical',
    `chair_cwid` VARCHAR(32) NULL,
    `scholar_count` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED',
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `department_slug_key`(`slug`),
    INDEX `department_slug_idx`(`slug`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `division` (
    `code` VARCHAR(64) NOT NULL,
    `dept_code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `chief_cwid` VARCHAR(32) NULL,
    `scholar_count` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED',
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `division_dept_code_idx`(`dept_code`),
    INDEX `division_slug_idx`(`slug`),
    UNIQUE INDEX `division_dept_code_slug_key`(`dept_code`, `slug`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `center` (
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `center_type` VARCHAR(16) NOT NULL DEFAULT 'center',
    `director_cwid` VARCHAR(32) NULL,
    `scholar_count` INTEGER NOT NULL DEFAULT 0,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(32) NOT NULL DEFAULT 'seed',
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `center_slug_key`(`slug`),
    INDEX `center_slug_idx`(`slug`),
    INDEX `center_sort_order_idx`(`sort_order`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `center_membership` (
    `center_code` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'manual',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `center_membership_cwid_idx`(`cwid`),
    PRIMARY KEY (`center_code`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication_topic` (
    `pmid` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `parent_topic_id` VARCHAR(128) NOT NULL,
    `primary_subtopic_id` VARCHAR(128) NULL,
    `subtopic_ids` JSON NULL,
    `subtopic_confidences` JSON NULL,
    `score` DECIMAL(8, 4) NOT NULL,
    `impact_score` DECIMAL(8, 4) NULL,
    `author_position` VARCHAR(16) NOT NULL,
    `year` SMALLINT NOT NULL,

    INDEX `publication_topic_cwid_parent_topic_id_score_idx`(`cwid`, `parent_topic_id`, `score` DESC),
    INDEX `publication_topic_parent_topic_id_year_score_idx`(`parent_topic_id`, `year` DESC, `score` DESC),
    INDEX `publication_topic_cwid_year_idx`(`cwid`, `year` DESC),
    INDEX `publication_topic_parent_topic_id_cwid_idx`(`parent_topic_id`, `cwid`),
    PRIMARY KEY (`pmid`, `cwid`, `parent_topic_id`)
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
CREATE TABLE `coi_activity` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `entity` VARCHAR(255) NULL,
    `activity_type` VARCHAR(255) NULL,
    `value` VARCHAR(64) NULL,
    `activity_relates_to` VARCHAR(64) NULL,
    `wcmc_facilities` VARCHAR(8) NULL,
    `purchasing_procurement` VARCHAR(8) NULL,
    `chair_approval` VARCHAR(64) NULL,
    `activity_group` VARCHAR(128) NULL,
    `description` TEXT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'COI',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `coi_activity_cwid_idx`(`cwid`),
    INDEX `coi_activity_cwid_activity_group_idx`(`cwid`, `activity_group`),
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
    `source` VARCHAR(64) NOT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `status` VARCHAR(16) NOT NULL,
    `rows_processed` INTEGER NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,
    `manifest_sha256` VARCHAR(64) NULL,
    `manifest_taxonomy_version` VARCHAR(64) NULL,

    INDEX `etl_run_source_started_at_idx`(`source`, `started_at`),
    INDEX `etl_run_source_status_completed_at_idx`(`source`, `status`, `completed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `completeness_snapshot` (
    `id` VARCHAR(64) NOT NULL,
    `snapshot_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `total_scholars` INTEGER NOT NULL,
    `complete_count` INTEGER NOT NULL,
    `completeness_percent` DOUBLE NOT NULL,
    `below_threshold` BOOLEAN NOT NULL,

    INDEX `completeness_snapshot_snapshot_at_idx`(`snapshot_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `spotlight` (
    `subtopic_id` VARCHAR(128) NOT NULL,
    `parent_topic_id` VARCHAR(128) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `display_name` VARCHAR(255) NOT NULL,
    `short_description` TEXT NOT NULL,
    `lede` TEXT NOT NULL,
    `papers` JSON NOT NULL,
    `artifact_version` VARCHAR(32) NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL,

    INDEX `spotlight_parent_topic_id_idx`(`parent_topic_id`),
    PRIMARY KEY (`subtopic_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scholar` ADD CONSTRAINT `scholar_dept_code_fkey` FOREIGN KEY (`dept_code`) REFERENCES `department`(`code`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scholar` ADD CONSTRAINT `scholar_div_code_fkey` FOREIGN KEY (`div_code`) REFERENCES `division`(`code`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scholar` ADD CONSTRAINT `scholar_postdoctoral_mentor_cwid_fkey` FOREIGN KEY (`postdoctoral_mentor_cwid`) REFERENCES `scholar`(`cwid`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointment` ADD CONSTRAINT `appointment_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `education` ADD CONSTRAINT `education_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `person_nih_profile` ADD CONSTRAINT `person_nih_profile_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grant` ADD CONSTRAINT `grant_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grant_publication` ADD CONSTRAINT `grant_publication_grant_id_fkey` FOREIGN KEY (`grant_id`) REFERENCES `grant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grant_publication` ADD CONSTRAINT `grant_publication_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_author` ADD CONSTRAINT `publication_author_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_author` ADD CONSTRAINT `publication_author_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `topic_assignment` ADD CONSTRAINT `topic_assignment_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subtopic` ADD CONSTRAINT `subtopic_parent_topic_id_fkey` FOREIGN KEY (`parent_topic_id`) REFERENCES `topic`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `division` ADD CONSTRAINT `division_dept_code_fkey` FOREIGN KEY (`dept_code`) REFERENCES `department`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `center_membership` ADD CONSTRAINT `center_membership_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_topic` ADD CONSTRAINT `publication_topic_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_topic` ADD CONSTRAINT `publication_topic_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_topic` ADD CONSTRAINT `publication_topic_parent_topic_id_fkey` FOREIGN KEY (`parent_topic_id`) REFERENCES `topic`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_score` ADD CONSTRAINT `publication_score_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_score` ADD CONSTRAINT `publication_score_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coi_activity` ADD CONSTRAINT `coi_activity_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cwid_alias` ADD CONSTRAINT `cwid_alias_current_cwid_fkey` FOREIGN KEY (`current_cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `slug_history` ADD CONSTRAINT `slug_history_current_cwid_fkey` FOREIGN KEY (`current_cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

