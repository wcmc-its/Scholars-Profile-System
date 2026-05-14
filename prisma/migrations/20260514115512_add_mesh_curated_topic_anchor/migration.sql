-- CreateTable
CREATE TABLE `mesh_curated_topic_anchor` (
    `descriptor_ui` VARCHAR(10) NOT NULL,
    `parent_topic_id` VARCHAR(128) NOT NULL,
    `confidence` VARCHAR(16) NOT NULL,
    `source_note` TEXT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`descriptor_ui`, `parent_topic_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
