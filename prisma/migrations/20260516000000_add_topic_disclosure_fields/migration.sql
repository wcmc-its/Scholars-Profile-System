-- AlterTable: Publication gains the per-paper top topic id (issue #325).
-- Sourced from DynamoDB TOPIC# `top_topic_id`. Per-paper truth — same value
-- repeats across the N TOPIC# rows for one pmid; the ETL writes once here.
-- FK to topic.id with ON DELETE SET NULL so the publication row survives
-- if a topic is ever pruned (topics aren't normally deleted).
ALTER TABLE `publication`
    ADD COLUMN `top_topic_id` VARCHAR(128) NULL;

ALTER TABLE `publication`
    ADD CONSTRAINT `publication_top_topic_id_fkey`
        FOREIGN KEY (`top_topic_id`) REFERENCES `topic`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `publication_top_topic_id_idx` ON `publication`(`top_topic_id`);

-- AlterTable: Topic gains the per-topic display threshold (issue #325).
-- Sourced from `hierarchy.json` topic node `display_threshold` (per
-- ReciterAI #69). Nullable: untuned topics fall back to the spec default
-- (0.5) at the consumer; storing NULL keeps "untuned" distinguishable
-- from "tuned to 0.5" for the tuning workstream.
ALTER TABLE `topic`
    ADD COLUMN `display_threshold` DOUBLE NULL;
