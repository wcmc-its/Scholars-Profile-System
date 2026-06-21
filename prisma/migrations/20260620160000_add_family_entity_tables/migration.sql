-- #1166 Methods Surface B specific-entity (cell-line) layer.
-- family_entity = entity DIMENSION (strip ranking + directory nesting; usage_count stored).
-- family_entity_usage = per-(publication x entity) FACTS (relevance sentence + matched_span).
-- Both keyed on stable (supercategory, family_label) (no FK); full-replacement load by etl/tools.

-- CreateTable
CREATE TABLE `family_entity` (
    `id` VARCHAR(64) NOT NULL,
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `normalized_entity_id` VARCHAR(128) NOT NULL,
    `entity_label` VARCHAR(255) NOT NULL,
    `parent_entity_id` VARCHAR(128) NULL,
    `parent_label` VARCHAR(255) NULL,
    `parent_descriptor` VARCHAR(255) NULL,
    `entity_role` VARCHAR(64) NULL,
    `usage_count` INTEGER NOT NULL,
    `evidenced` BOOLEAN NOT NULL DEFAULT false,
    `source_artifact_sha` VARCHAR(64) NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `family_entity_supercategory_family_label_usage_count_idx`(`supercategory`, `family_label`, `usage_count` DESC),
    INDEX `family_entity_parent_entity_id_idx`(`parent_entity_id`),
    UNIQUE INDEX `family_entity_supercategory_family_label_normalized_entity_i_key`(`supercategory`, `family_label`, `normalized_entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `family_entity_usage` (
    `id` VARCHAR(64) NOT NULL,
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `normalized_entity_id` VARCHAR(128) NOT NULL,
    `pmid` VARCHAR(16) NOT NULL,
    `usage_sentence` TEXT NOT NULL,
    `matched_span_start` INTEGER NULL,
    `matched_span_end` INTEGER NULL,
    `centrality_score` DECIMAL(6, 4) NULL,
    `entity_role` VARCHAR(64) NULL,
    `source_artifact_sha` VARCHAR(64) NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `family_entity_usage_supercategory_family_label_normalized_en_idx`(`supercategory`, `family_label`, `normalized_entity_id`),
    INDEX `family_entity_usage_pmid_idx`(`pmid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

