-- Title resolution: keep the ED raw inputs beside the resolved display title.
--
-- `scholar.primary_title` keeps its name and becomes the RESOLVED value, so no
-- read site changes. The two columns added here are the raw tiers the `/edit`
-- picker offers once a higher tier has won:
--
--   ed_primary_title  ED weillCornellEduPrimaryTitle
--   working_title     ED weillCornellEduWorkingTitle  (49 of 8,769 entries)
--
-- Both NULL until the next ED ETL run populates them; the resolution post-pass
-- treats a NULL tier as "does not apply" and falls through, so an un-backfilled
-- row resolves exactly as it does today.
--
-- Hand-written: `prisma migrate diff` emits ~44 unrelated JSON ALTERs against
-- clean master in this repo (see CLAUDE.md), so it is not usable here.

ALTER TABLE `scholar`
  ADD COLUMN `ed_primary_title` VARCHAR(255) NULL AFTER `primary_title`,
  ADD COLUMN `working_title` VARCHAR(255) NULL AFTER `ed_primary_title`;
