-- Issue #89 — widen issue + pages to fit messy real-world values from
-- analysis_summary_article. Observed maxes: volume 23, issue 100, pages 72.
-- Source columns are varchar(500); we don't need that much, but we
-- do need to clear the 64-char wall a few hundred rows trip on.

ALTER TABLE `publication`
  MODIFY COLUMN `issue` VARCHAR(128) NULL,
  MODIFY COLUMN `pages` VARCHAR(128) NULL;
