-- Issue #92 — track which source produced the current grant abstract.
--
-- Existing populated rows came from NIH RePORTER (the only source until
-- now), so backfill them to 'reporter'. Subsequent ETL runs from non-NIH
-- sources (NSF, PCORI, CDMRP, Gates) set the source to their own slug.
--
-- VARCHAR(32) leaves headroom; current values are 'reporter' (6),
-- 'nsf' (3), 'pcori' (5), 'cdmrp' (5), 'gates' (5).

-- AlterTable
ALTER TABLE `grant`
  ADD COLUMN `abstract_source` VARCHAR(32) NULL;

-- Backfill: any row with a populated abstract today came from RePORTER.
UPDATE `grant`
   SET `abstract_source` = 'reporter'
 WHERE `abstract` IS NOT NULL
   AND `abstract_source` IS NULL;
