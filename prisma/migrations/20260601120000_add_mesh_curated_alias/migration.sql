-- CreateTable
CREATE TABLE `mesh_curated_alias` (
    `alias` VARCHAR(255) NOT NULL,
    `descriptor_ui` VARCHAR(10) NOT NULL,
    `source_note` TEXT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mesh_curated_alias_descriptor_ui_idx`(`descriptor_ui`),
    PRIMARY KEY (`alias`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

