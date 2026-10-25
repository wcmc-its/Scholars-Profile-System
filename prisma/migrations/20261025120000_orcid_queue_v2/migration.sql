-- ORCID queue v2 (docs/orcid-librarian-queue-spec.md, "v2"). Additive DDL only: three columns
-- with defaults or NULL, so the v1 image keeps working against the new schema.

-- AlterTable
-- history_match: an ORCID affiliation matches the scholar's own history (education, external
-- appointments, ReCiter Identity institutions). evidence_detail: the facts behind each evidence
-- chip, written by etl/orcid-evidence; NULL on rows a v1 run wrote.
ALTER TABLE `orcid_candidate_evidence` ADD COLUMN `history_match` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `evidence_detail` JSON NULL;

-- AlterTable
-- The queue filter a sample was drawn under ("" = none): it authorizes bulk confirm for that
-- filter only. Existing samples read as unfiltered.
ALTER TABLE `orcid_queue_sample` ADD COLUMN `filter_key` VARCHAR(1024) NOT NULL DEFAULT '';
