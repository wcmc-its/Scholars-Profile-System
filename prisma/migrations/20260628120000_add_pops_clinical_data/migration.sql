-- POPS clinical enrichment columns on scholar.
-- Backfilled nightly by etl/pops/index.ts for scholars where has_clinical_profile = 1.
-- All nullable; no default; never touches existing rows until the ETL runs.
ALTER TABLE `scholar`
  ADD COLUMN `pops_board_certifications` JSON NULL,
  ADD COLUMN `pops_specialties` JSON NULL,
  ADD COLUMN `pops_expertise` JSON NULL,
  ADD COLUMN `pops_refreshed_at` DATETIME(3) NULL;
