-- CreateTable
CREATE TABLE `mesh_curated_family_anchor` (
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `descriptor_ui` VARCHAR(10) NOT NULL,
    `confidence` VARCHAR(16) NOT NULL,
    `source_note` TEXT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mesh_curated_family_anchor_descriptor_ui_idx`(`descriptor_ui`),
    PRIMARY KEY (`supercategory`, `family_label`, `descriptor_ui`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
