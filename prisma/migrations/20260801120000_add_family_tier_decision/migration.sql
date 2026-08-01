-- CreateTable
CREATE TABLE `family_tier_decision` (
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `tier` VARCHAR(16) NOT NULL,
    `decided_by` VARCHAR(32) NULL,
    `decided_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`supercategory`, `family_label`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill (#1993): infer a decision row for every EXISTING `source='steward'`
-- overlay row, tier taken from which overlay currently holds it. `decided_by`
-- is left NULL — these rows predate this table and the overlay itself never
-- recorded an actor (the audit log does, but joining it back onto an overlay
-- row is not reliable: a family can have been tiered more than once).
-- Historical Public decisions cannot be backfilled at all — a Public tier has
-- never left a row anywhere, which is exactly the defect this table closes
-- going forward. `INSERT IGNORE` is belt-and-braces only: today's tier route
-- keeps a family in at most one overlay at a time, so the two backfills below
-- cannot collide on the same (supercategory, family_label) primary key.
INSERT IGNORE INTO `family_tier_decision`
  (`supercategory`, `family_label`, `tier`, `decided_by`, `decided_at`)
SELECT `supercategory`, `family_label`, 'suppressed', NULL, `refreshed_at`
FROM `family_suppression_overlay`
WHERE `source` = 'steward';

INSERT IGNORE INTO `family_tier_decision`
  (`supercategory`, `family_label`, `tier`, `decided_by`, `decided_at`)
SELECT `supercategory`, `family_label`, 'sensitive', NULL, `refreshed_at`
FROM `family_sensitivity_overlay`
WHERE `source` = 'steward';
