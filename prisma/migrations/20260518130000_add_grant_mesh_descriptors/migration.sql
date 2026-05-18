-- AlterTable
ALTER TABLE `grant` ADD COLUMN `mesh_descriptor_uis` JSON NULL,
    ADD COLUMN `mesh_resolution_coverage` DOUBLE NULL,
    ADD COLUMN `mesh_resolved_at` DATETIME(3) NULL;
