-- Matcha-admin Phase 1b: manual corpus suppression on `opportunity`. A set
-- `suppressed_at` hides the row from browse/detail/matcher reads and drops it
-- from the search index on the next nightly rebuild; restore nulls all three
-- columns. Additive-only, no backfill: existing rows land NULL = visible. The
-- nightly GRANT# upsert (etl/dynamodb/grant-opportunity-etl.ts) never names
-- these columns, so suppression survives re-ingest.

-- AlterTable
ALTER TABLE `opportunity` ADD COLUMN `suppressed_at` DATETIME(3) NULL,
    ADD COLUMN `suppressed_by` VARCHAR(64) NULL,
    ADD COLUMN `suppress_reason` VARCHAR(255) NULL;
