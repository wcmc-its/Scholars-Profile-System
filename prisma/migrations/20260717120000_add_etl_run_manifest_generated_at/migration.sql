-- Freshness anchor fix (§2.1). The ETL heartbeat (etl/freshness) measured each
-- source's age from `etl_run.completed_at` — the row's insert time. But the
-- spotlight/hierarchy/tools loaders write a fresh SUCCESS row on an unchanged-
-- sha256 short-circuit (rows_processed=0, completed_at=now), which reset the
-- freshness clock even though the underlying S3 artifact had not changed. A
-- frozen producer therefore read as fresh (demonstrated in prod: Spotlight age
-- climbed to 4.4d, then a short-circuit run reset it to 0.9h).
--
-- This column carries the producer's `manifest.generated_at` — the artifact's
-- real publish moment — so freshness anchors on content age, not job liveness.
-- Nullable + additive: a populated table is safe to alter, and sources with no
-- S3 manifest (ED, ReCiter, …) leave it NULL, where freshness falls back to
-- completed_at (unchanged behaviour).

-- AlterTable
ALTER TABLE `etl_run` ADD COLUMN `manifest_generated_at` DATETIME(3) NULL;
