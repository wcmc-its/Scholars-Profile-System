-- Structured eligibility map from ReciterAI (GRANT# contract v2, #290 + v2 facets).
-- Nullable, no backfill here: rows fill on the next ReciterAI reproject / etl:dynamodb run,
-- and pre-backfill rows fall back to the prose-regex flag derivation.
ALTER TABLE `opportunity`
  ADD COLUMN `eligibility` JSON NULL;
