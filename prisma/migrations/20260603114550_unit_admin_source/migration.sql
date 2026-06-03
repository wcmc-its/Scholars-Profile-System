-- AlterTable
ALTER TABLE `unit_admin` ADD COLUMN `source` VARCHAR(32) NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX `unit_admin_source_idx` ON `unit_admin`(`source`);

