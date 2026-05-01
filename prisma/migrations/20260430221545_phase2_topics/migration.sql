-- Phase 2 D-02 candidate (e): topic taxonomy data layer.
-- See .planning/phases/02-algorithmic-surfaces-and-home-composition/02-SCHEMA-DECISION.md
--
-- Additive only — no DROP COLUMN, no DROP TABLE, no RENAME. Existing
-- topic_assignment + publication_score tables are preserved unchanged.
--
-- topic            : 67-row catalog projected from TAXONOMY#taxonomy_v2.topics[].
-- publication_topic: ~78,103-row (publication × scholar × parent_topic) triples
--                    projected from TOPIC# DynamoDB partitions. Subtopic data is
--                    embedded as JSON; subtopics are NOT first-class entities.

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

-- AddForeignKey
ALTER TABLE `publication_topic` ADD CONSTRAINT `publication_topic_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_topic` ADD CONSTRAINT `publication_topic_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_topic` ADD CONSTRAINT `publication_topic_parent_topic_id_fkey` FOREIGN KEY (`parent_topic_id`) REFERENCES `topic`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
