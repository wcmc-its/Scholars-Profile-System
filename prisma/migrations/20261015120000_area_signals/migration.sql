-- Grants and clinical trials as research-area ranking signals. Additive DDL
-- only: two nullable columns and two new tables that nothing reads until the
-- image that writes them ships (etl/area-signal-inputs, etl/dynamodb).

-- AlterTable
-- Hash of the normalized title + text this row was sent to ReciterAI under.
-- Null when the row is not an eligible area signal.
ALTER TABLE `grant` ADD COLUMN `area_text_key` VARCHAR(64) NULL;
ALTER TABLE `clinical_trial` ADD COLUMN `area_text_key` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `grant_area_text_key_idx` ON `grant`(`area_text_key`);
CREATE INDEX `clinical_trial_area_text_key_idx` ON `clinical_trial`(`area_text_key`);

-- CreateTable
-- One row per scored text, projected from reciterai AREASIGNAL#{kind}:{text_key}.
CREATE TABLE `area_signal_text` (
    `text_key` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `synopsis` TEXT NULL,
    `synopsis_model` VARCHAR(128) NULL,
    `taxonomy_version` VARCHAR(64) NULL,
    `scored_at` DATETIME(3) NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`text_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- The research-area scores of one text (topic_scores upstream).
CREATE TABLE `area_signal_topic` (
    `text_key` VARCHAR(64) NOT NULL,
    `parent_topic_id` VARCHAR(128) NOT NULL,
    `score` DECIMAL(8, 4) NOT NULL,

    INDEX `area_signal_topic_parent_topic_id_idx`(`parent_topic_id`),
    PRIMARY KEY (`text_key`, `parent_topic_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `area_signal_topic` ADD CONSTRAINT `area_signal_topic_text_key_fkey` FOREIGN KEY (`text_key`) REFERENCES `area_signal_text`(`text_key`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `area_signal_topic` ADD CONSTRAINT `area_signal_topic_parent_topic_id_fkey` FOREIGN KEY (`parent_topic_id`) REFERENCES `topic`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
