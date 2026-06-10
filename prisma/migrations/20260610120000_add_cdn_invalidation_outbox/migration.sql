-- #353 — ADR-005 failure-model layer 3: durable outbox for a failed CloudFront invalidation.
-- The CDN analogue of #393's search-index reconciler. Generated offline
-- (`prisma migrate diff --from-schema <master> --to-schema <edited> --script`),
-- per project_prisma_migration_offline (the local dev DB is drifted; never `migrate dev`).
-- Additive only: one new table, no drops/alters of any existing table.
--
-- Unlike #393 (which re-derives its payload from current DB state and persists
-- nothing), the paths-to-purge here are NOT recomputable — a later slug flip,
-- PROFILE_CANONICAL change, or mutated author set makes the originally-cached
-- path underivable — so the exact paths are REMEMBERED in `paths` (JSON array).
-- `invalidated_at` is the NULL-sentinel (NULL = pending; stamped now() on a
-- successful CreateInvalidation); the reconciler (lib/edit/cdn-reconcile.ts)
-- replays any pending row's paths past the grace window until it lands. Dormant
-- (never written) until SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID is set.

-- CreateTable
CREATE TABLE `cdn_invalidation` (
    `id` VARCHAR(64) NOT NULL,
    `paths` TEXT NOT NULL,
    `invalidated_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cdn_invalidation_invalidated_at_idx`(`invalidated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
