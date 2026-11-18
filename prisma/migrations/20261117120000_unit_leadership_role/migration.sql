-- Vice Chair roles: department-authored leadership titles, steward-maintained
-- on /edit. A separate table from org_unit_role_assignment, which the ED ETL
-- writes nightly and which has no per-holder title. Additive; no data here
-- (the seed is scripts/backfills/2026-11-17-seed-vice-chairs.ts).

-- CreateTable
CREATE TABLE `unit_leadership_role` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `entity_type` VARCHAR(32) NOT NULL,
    `entity_id` VARCHAR(64) NOT NULL,
    `role_family` VARCHAR(32) NOT NULL DEFAULT 'vice_chair',
    `tier` VARCHAR(16) NOT NULL,
    `functions` VARCHAR(255) NOT NULL DEFAULT '',
    `area_text` VARCHAR(255) NULL,
    `site` VARCHAR(32) NULL,
    `display_title` VARCHAR(255) NOT NULL,
    `start_date` DATE NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'steward',
    `source_url` VARCHAR(512) NULL,
    `source_observed_at` DATE NULL,
    `show_on_profile` BOOLEAN NOT NULL DEFAULT true,
    `note` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `unit_leadership_role_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    INDEX `unit_leadership_role_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `unit_leadership_role` ADD CONSTRAINT `unit_leadership_role_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
