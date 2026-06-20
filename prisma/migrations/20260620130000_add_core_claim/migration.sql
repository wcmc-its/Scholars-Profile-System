-- Cores inference — the claim layer (ADR-005 manual-override pattern).
--
--   1) Extend the shared `EntityType` ENUM with `core` on all three columns that
--      use it (`field_override`, `suppression`, `unit_admin`) so the Prisma
--      client and the DB stay in sync — exactly mirroring the #160 `mentee`
--      migration. Additive: a widened ENUM does not invalidate any stored value,
--      and `MODIFY` of an enum column that is part of a composite PK (`unit_admin`)
--      is a no-data-conversion metadata change, so the PK is left in place (NOT
--      dropped/re-added). Only `unit_admin` actually carries `core` rows (a core
--      owner = UnitAdmin(entityType="core", role=owner)); the other two are
--      widened only to keep the one shared Prisma enum consistent.
--
--   2) Create `core_claim` — the ETL-immune override table. A core owner's
--      claim/rejection of a (publication, core) usage, keyed on the same stable
--      (pmid, core_id) pair as `publication_core` and read-merged with precedence
--      over the ETL-projected status. No FK (the same ETL-immunity ADR-005 uses).
--
-- The audit log's `target_entity_type`/`action` ENUMs gain `core`/`core_claim`
-- in the same PR (scripts/sql/audit-log.sql — separate database, separate file).
-- Additive only; no existing object is dropped.

-- AlterTable
ALTER TABLE `field_override` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core') NOT NULL;

-- AlterTable
ALTER TABLE `suppression` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core') NOT NULL;

-- AlterTable
ALTER TABLE `unit_admin` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core') NOT NULL;

-- CreateTable
CREATE TABLE `core_claim` (
    `id` VARCHAR(64) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `core_id` VARCHAR(32) NOT NULL,
    `claim_status` ENUM('claimed', 'rejected') NOT NULL,
    `claimed_by` VARCHAR(32) NOT NULL,
    `claimed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` TEXT NULL,
    `revoked_by` VARCHAR(32) NULL,
    `revoked_at` DATETIME(3) NULL,

    INDEX `core_claim_core_id_idx`(`core_id`),
    UNIQUE INDEX `core_claim_pmid_core_id_key`(`pmid`, `core_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
