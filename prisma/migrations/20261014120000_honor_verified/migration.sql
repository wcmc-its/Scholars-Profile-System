-- Honors queue "User asserted" tab — a curator marks a self-asserted honor as
-- verified. NULL = self-reported. Additive DDL only; the running image never
-- selects these columns, so this can land ahead of the image.

-- AlterTable
ALTER TABLE `honor` ADD COLUMN `verified_at` DATETIME(3) NULL,
    ADD COLUMN `verified_by_cwid` VARCHAR(32) NULL;
