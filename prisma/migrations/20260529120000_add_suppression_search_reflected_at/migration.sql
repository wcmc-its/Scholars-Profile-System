-- #393 — ADR-005 failure-model layer 3: suppression search-index reconciler sentinel.
-- Generated offline (`prisma migrate diff --from-schema <HEAD> --to-schema <edited>`),
-- per project_prisma_migration_offline (the local dev DB is drifted; never `migrate dev`).
-- Additive + NULLABLE: existing rows read as NULL = "latest transition not yet
-- reflected into OpenSearch". The reconciler (lib/edit/search-reconcile.ts) treats a
-- scholar/publication row with NULL past the grace window as stale and re-reflects it;
-- a successful reflect stamps now(), and a revoke resets it to NULL.

-- AlterTable
ALTER TABLE `suppression` ADD COLUMN `search_reflected_at` DATETIME(3) NULL;
