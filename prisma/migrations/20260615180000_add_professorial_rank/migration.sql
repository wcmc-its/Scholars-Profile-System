-- Professorial rank derived from the ASMS-authoritative ED person-type leaf (#1034).
--
-- One of 'Assistant Professor' | 'Associate Professor' | 'Professor', mapped by
-- lib/faculty-rank.ts:deriveProfessorialRank from weillCornellEduPersonTypeCode
-- (academic-faculty-assistant|associate|fullprofessor; probe #1036). Nullable so
-- the additive migration applies cleanly; the ED ETL backfills on its next run,
-- and the Jenzabar GS import reads it to normalize Grad-School appointment titles
-- (Rule B). NULL for instructor/lecturer/non-faculty, where the GS title is left
-- as-is.
ALTER TABLE `scholar` ADD COLUMN `professorial_rank` VARCHAR(32) NULL;
