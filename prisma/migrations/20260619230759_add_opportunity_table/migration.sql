-- CreateTable
CREATE TABLE `opportunity` (
    `opportunity_id` VARCHAR(128) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `source_url` VARCHAR(512) NOT NULL,
    `sponsor` VARCHAR(255) NOT NULL,
    `title` TEXT NOT NULL,
    `synopsis` TEXT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `open_date` DATE NULL,
    `due_date` DATE NULL,
    `eligibility_raw` TEXT NOT NULL,
    `eligibility_flags` JSON NOT NULL,
    `cfda_list` JSON NOT NULL,
    `mechanism` VARCHAR(16) NULL,
    `award_ceiling` BIGINT NULL,
    `award_floor` BIGINT NULL,
    `estimated_funding` BIGINT NULL,
    `number_of_awards` INTEGER NULL,
    `primary_topic_id` VARCHAR(128) NULL,
    `topic_vector` JSON NOT NULL,
    `appeal_by_stage` JSON NOT NULL,
    `is_research` BOOLEAN NOT NULL,
    `mesh_descriptor_ui` JSON NULL,
    `taxonomy_version` VARCHAR(32) NOT NULL,
    `ingested_at` DATETIME(3) NOT NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `opportunity_status_idx`(`status`),
    INDEX `opportunity_due_date_idx`(`due_date`),
    INDEX `opportunity_primary_topic_id_idx`(`primary_topic_id`),
    PRIMARY KEY (`opportunity_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

