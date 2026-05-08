-- Issue #78 Wave B — structured Funding columns on `grant`. Additive only;
-- existing `funder` column is retained for transition (Wave C migrates UI;
-- a later cleanup will drop it). All new columns nullable or defaulted so
-- the migration applies cleanly to existing rows; the InfoEd ETL backfills
-- on its next run.

-- AlterTable
ALTER TABLE `grant`
  ADD COLUMN `program_type`        VARCHAR(64)  NOT NULL DEFAULT 'Grant',
  ADD COLUMN `prime_sponsor`       VARCHAR(64)  NULL,
  ADD COLUMN `prime_sponsor_raw`   VARCHAR(255) NULL,
  ADD COLUMN `direct_sponsor`      VARCHAR(64)  NULL,
  ADD COLUMN `direct_sponsor_raw`  VARCHAR(255) NULL,
  ADD COLUMN `mechanism`           VARCHAR(16)  NULL,
  ADD COLUMN `nih_ic`              VARCHAR(8)   NULL,
  ADD COLUMN `is_subaward`         BOOLEAN      NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `grant_prime_sponsor_idx` ON `grant`(`prime_sponsor`);

-- CreateIndex
CREATE INDEX `grant_program_type_idx` ON `grant`(`program_type`);
