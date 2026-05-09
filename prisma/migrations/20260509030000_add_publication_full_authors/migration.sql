-- Issue #89 — full author list for Word bibliography export. Sourced
-- from reciterdb.analysis_summary_author_all.authors (varchar(5000),
-- pipe-separated). Stored as TEXT to accommodate the long-tail
-- 100-author papers without per-row varchar overflow.

ALTER TABLE `publication` ADD COLUMN `full_authors_string` TEXT NULL;
