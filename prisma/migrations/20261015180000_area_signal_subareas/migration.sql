-- Subarea assignments for grant and trial area scores (area-signals plan S7).
-- Additive DDL only: three nullable columns and one index on a table the
-- area activity feed reads. Null means unassigned; the ETL writes these from
-- the optional per-topic_scores fields ReciterAI adds (primary_subtopic_id,
-- subtopic_ids, subtopic_confidences). No FK on the slug, like
-- publication_topic.primary_subtopic_id.

-- AlterTable
ALTER TABLE `area_signal_topic`
    ADD COLUMN `primary_subtopic_id` VARCHAR(128) NULL,
    ADD COLUMN `subtopic_ids` JSON NULL,
    ADD COLUMN `subtopic_confidences` JSON NULL;

-- CreateIndex
CREATE INDEX `area_signal_topic_parent_topic_id_primary_subtopic_id_idx` ON `area_signal_topic`(`parent_topic_id`, `primary_subtopic_id`);
