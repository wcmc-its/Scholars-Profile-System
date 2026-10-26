-- NCI Table 2a (report 2): a reviewer's free-text note on an award, e.g. why
-- it is less than 100% cancer-relevant. MCC asked for it as a DT2A column.
-- Additive and nullable; NULL = no note.
ALTER TABLE `cancer_center_funding_award`
  ADD COLUMN `reviewer_note` TEXT NULL AFTER `cancer_relevant_inferred_at`;
