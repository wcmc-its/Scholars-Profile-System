-- Phase 9 SPOTLIGHT-01 — projection of the ReciterAI spotlight artifact.
-- Sole writer is etl/spotlight/index.ts (Plan 09-02). Each publish is a full
-- replacement; subtopic_id is NOT a FK to subtopic (D-06: subtopic IDs are
-- unstable across hierarchy recomputes; spotlight + hierarchy publish cycles
-- are independent). D-19 LOCKED: display_name, short_description, lede are
-- UI-facing only — never pass them to an LLM, retrieval, or embedding path.

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
