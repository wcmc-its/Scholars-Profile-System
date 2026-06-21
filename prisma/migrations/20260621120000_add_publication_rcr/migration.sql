-- AlterTable
-- #917 v6 -- NIH iCite bibliometrics (sourced from reciterdb.analysis_nih, keyed by
-- pmid, refreshed by the weekly reciter ETL). Additive nullable columns; sit dark
-- until the ETL backfills. Used by the NIH-biosketch impact grounding only; never
-- surfaced in the public overview.
ALTER TABLE `publication`
  ADD COLUMN `relative_citation_ratio` DECIMAL(6, 2) NULL,
  ADD COLUMN `nih_percentile` DECIMAL(5, 2) NULL,
  ADD COLUMN `cited_by_count` INTEGER NULL;
