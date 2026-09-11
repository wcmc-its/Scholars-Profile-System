-- Matcha — persist the engine's answer next to the paste it already retains.
--
-- The route's only cache was an in-process Map (5 min fresh, 30 min hard
-- eviction, per Fargate task, wiped on deploy), so a saved search replayed
-- from Recent on a later day always re-ran the Sonnet extraction and every
-- per-concept OpenSearch search (~13-15 s, one Bedrock call per replay).
--
-- `result` holds `{ concepts, candidates, titleSummary, culled }` for a run
-- that produced candidates; NULL for a zero-candidate (degraded) run and for
-- rows written while serving a stored result. `result_key` is the route's
-- full cache key so include-chip / eligibility variants stay distinct.
-- `preferences` (verbatim paste slices) is deliberately not stored.
--
-- Erasure is unchanged: DELETE already removes every row of a paste by
-- description_hash, so the stored answers go with the paste.
--
-- The existing description_hash index serves the lookup
-- (WHERE description_hash = ? AND result_key = ? ORDER BY created_at DESC):
-- a paste has a handful of rows, so no composite index is added.

ALTER TABLE `sponsor_match_submission`
    ADD COLUMN `result` JSON NULL,
    ADD COLUMN `result_key` VARCHAR(200) NULL;
