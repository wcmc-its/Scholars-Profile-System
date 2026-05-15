-- AlterTable: Publication gains global per-pmid impact fields sourced from
-- DynamoDB IMPACT# records (issue #316 PR-A).
ALTER TABLE `publication`
    ADD COLUMN `impact_score` DECIMAL(8, 4) NULL,
    ADD COLUMN `impact_justification` TEXT NULL,
    ADD COLUMN `impact_score_model` VARCHAR(64) NULL,
    ADD COLUMN `impact_refreshed_at` DATETIME(3) NULL;

-- AlterTable: PublicationTopic gains per-(pmid, cwid, parent_topic) text fields
-- already present in TOPIC# DynamoDB records but previously dropped on the floor.
ALTER TABLE `publication_topic`
    ADD COLUMN `rationale` TEXT NULL,
    ADD COLUMN `synopsis` TEXT NULL;
