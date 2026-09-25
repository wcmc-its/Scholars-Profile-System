-- NCI Table 2a (report 2, PR 2b): keep Bedrock's proposed cancer-relevant
-- percent in its own column, so the review status can tell a reviewer's
-- correction ("Corrected · AI said X%") from a confirmation. Additive and
-- nullable; the backfill copies the current value only where nobody has
-- reviewed it yet (source = 'llm'), since a human-sourced value is not what
-- the model said. Safe on an empty table.
ALTER TABLE `cancer_center_funding_award`
  ADD COLUMN `cancer_relevant_percent_ai` DECIMAL(5, 2) NULL AFTER `cancer_relevant_percent_source`;

UPDATE `cancer_center_funding_award`
  SET `cancer_relevant_percent_ai` = `cancer_relevant_percent`
  WHERE `cancer_relevant_percent_source` = 'llm';
