-- CreateTable
CREATE TABLE `mesh_descriptor` (
    `descriptor_ui` VARCHAR(10) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `entry_terms` JSON NOT NULL,
    `tree_numbers` JSON NOT NULL,
    `scope_note` TEXT NULL,
    `date_revised` DATE NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mesh_descriptor_name_idx`(`name`),
    PRIMARY KEY (`descriptor_ui`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
