-- NCI Table 2A relevance follows MCC's rubric, with provenance.
-- Additive DDL only. `grant.phr_text` holds RePORTER's Public Health Relevance
-- statement (filled by the next nightly RePORTER step); the four
-- `cancer_center_funding_award` columns record which model (or MCC rule),
-- prompt and inputs produced the AI/rule cancer-relevant value. All nullable.

-- AlterTable
ALTER TABLE `grant`
    ADD COLUMN `phr_text` TEXT NULL;

-- AlterTable
ALTER TABLE `cancer_center_funding_award`
    ADD COLUMN `cancer_relevant_model` VARCHAR(128) NULL,
    ADD COLUMN `cancer_relevant_prompt_hash` VARCHAR(12) NULL,
    ADD COLUMN `cancer_relevant_input_hash` VARCHAR(64) NULL,
    ADD COLUMN `cancer_relevant_inferred_at` DATETIME(3) NULL;
