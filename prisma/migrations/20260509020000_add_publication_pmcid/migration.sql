-- Issue #87 — surface PMID/PMCID on publication cards. PMCID lives in
-- reciterdb.analysis_summary_article.pmcid (varchar(128), stored with the
-- `PMC` prefix). Additive nullable column; reciter ETL backfills on next run.

ALTER TABLE `publication` ADD COLUMN `pmcid` VARCHAR(32) NULL;
