-- AlterTable: add scholar.role_category for the Phase 2 algorithmic-surface
-- eligibility carve. Derived in ED ETL per design-spec-v1.7.1.md:352-356.
-- Nullable so this applies cleanly to the existing 8,943 active rows; ED ETL
-- backfills on next refresh.
ALTER TABLE `scholar` ADD COLUMN `role_category` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `scholar_role_category_idx` ON `scholar`(`role_category`);
