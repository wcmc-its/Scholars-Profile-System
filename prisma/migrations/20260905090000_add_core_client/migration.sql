-- Cores inference — known-client attestations (ReciterAI #383 / SPS #2607,
-- CWID-only pass).
--
-- `core_client` is the CoreClaim-style ETL-immune override table: a core
-- owner's manual attestation that a given CWID is a known user of the core,
-- independent of any publication evidence. No FK (same ETL-immunity posture
-- as `core_claim` — a client CWID may precede a Scholar row or outlive a core
-- delete). Soft-remove only (`removed_by`/`removed_at`) — "active" is
-- `removed_at IS NULL`.
--
-- The audit log's `action` ENUM gains `core_client_add`/`core_client_remove`
-- in the same PR (scripts/sql/audit-log.sql — separate database, separate
-- file); `target_entity_type` already has `core` from the #1239 core_claim
-- migration, so no ENUM widening is needed there.

-- CreateTable
CREATE TABLE `core_client` (
    `id` VARCHAR(64) NOT NULL,
    `core_id` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `added_by` VARCHAR(32) NOT NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `removed_by` VARCHAR(32) NULL,
    `removed_at` DATETIME(3) NULL,

    INDEX `core_client_core_id_idx`(`core_id`),
    UNIQUE INDEX `core_client_core_id_cwid_key`(`core_id`, `cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
