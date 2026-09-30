-- Core Review Queue v2 PR B — "Add PMIDs → Send to review".
--
-- `core_queue_add` holds the PMIDs a core owner sent to their own review queue
-- by hand. Deliberately a separate table, NOT a new `core_claim.claim_status`
-- value (assessment decision 1, 2026-09-28): claim semantics stay untouched. A
-- queued pmid shows under the unscored "Added by you" rail group while it has
-- no active claim; a claim, once made, wins. Rows are never deleted by a
-- decision, so revoking the decision returns the paper to the queue.
--
-- No FK (the same ETL-immunity posture as `core_claim`/`core_client`). The
-- UNIQUE (core_id, pmid) index is the dedupe and also serves every per-core read
-- (core_id is its leading column), so there is no separate core_id index.
--
-- The audit log's `action` ENUM gains `core_queue_add` in the same PR
-- (scripts/sql/audit-log.sql — separate database, applied by the deploy's
-- db-bootstrap step); `target_entity_type` already has `core`, so no widening
-- there. Additive DDL only: one new table. The running app image never selects
-- it, so this can land ahead of the image that reads it.

-- CreateTable
CREATE TABLE `core_queue_add` (
    `id` VARCHAR(64) NOT NULL,
    `core_id` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `added_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `core_queue_add_core_id_pmid_key`(`core_id`, `pmid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
