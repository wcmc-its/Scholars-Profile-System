-- AlterTable
-- #2654 -- an optional, scholar-typed label (the application name) so saved biosketch drafts
-- are tellable apart in the drafts list. Additive + nullable; existing rows read NULL (no
-- backfill) and render by mode + date as before.
ALTER TABLE `biosketch_generation`
  ADD COLUMN `label` VARCHAR(120) NULL;
