-- #540 Phase 1 — Unit curation schema migration
-- Implements ADR-005 Amendment 1 § A1.1 (Storage extensions).
--
-- Additive only:
--   * `EntityType` ENUM gains department / division / center on both
--     `field_override` and `suppression` tables that reference it.
--   * `center.leader_interim` adds the in-row interim/acting qualifier.
--     Dept/div express the same qualifier as a columnless `field_override`
--     row instead (no schema change there).
--   * `division_membership` is the manual roster of a manually-created
--     division (`Division.source='manual'`). Mirrors `center_membership`;
--     no FK to `scholar` (a roster row may exist before the scholar's ED
--     record arrives).
--   * `unit_admin` is the per-unit administrator grant carrying a
--     `UnitRole` enum (owner subsumes curator). Hard-deleted on revoke;
--     B03 audits both grant and revoke.
--
-- Backwards-compatible: existing rows remain valid (ENUM extension does
-- not invalidate stored values); no existing column drops.
--
-- See also: scripts/sql/audit-log.sql — the audit log's `target_entity_type`
-- and `action` ENUMs are extended in the same PR (separate database, separate
-- file).

-- AlterTable
ALTER TABLE `center` ADD COLUMN `leader_interim` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `field_override` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center') NOT NULL;

-- AlterTable
ALTER TABLE `suppression` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center') NOT NULL;

-- CreateTable
CREATE TABLE `division_membership` (
    `division_code` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'manual-ui',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `division_membership_cwid_idx`(`cwid`),
    PRIMARY KEY (`division_code`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `unit_admin` (
    `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center') NOT NULL,
    `entity_id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `role` ENUM('owner', 'curator') NOT NULL,
    `granted_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `unit_admin_cwid_idx`(`cwid`),
    PRIMARY KEY (`entity_type`, `entity_id`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
