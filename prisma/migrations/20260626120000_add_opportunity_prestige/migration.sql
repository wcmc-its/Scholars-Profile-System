-- Opportunity prestige signal (GRANT# contract v2) + honorific flag.
-- Both nullable, no backfill: rows fill on the next ReciterAI reproject.
ALTER TABLE `opportunity`
  ADD COLUMN `prestige` JSON NULL,
  ADD COLUMN `is_honorific` BOOLEAN NULL;
