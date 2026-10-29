-- NCI Table 2a (report 2): trainee slots on a training award, for the DT2A
-- "T" section. A reviewer enters it by hand (MCC, 2026-10-29: the Graduate
-- School or the Postdoc Office is the source; there is no feed).
-- Additive and nullable; NULL = not entered.
ALTER TABLE `cancer_center_funding_award`
  ADD COLUMN `trainee_slots` INT NULL AFTER `reviewer_note`;
