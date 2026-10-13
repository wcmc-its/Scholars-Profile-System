-- Honor tiers — a curator's tier override (1 highest .. 6) for one honor row.
-- NULL = the rule-derived tier (lib/honors/tiers.ts). Additive DDL only; the
-- running image never selects it, so this can land ahead of the image.

-- AlterTable
ALTER TABLE `honor` ADD COLUMN `tier_override` TINYINT NULL;
