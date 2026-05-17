-- CreateTable
CREATE TABLE `field_override` (
    `id` VARCHAR(64) NOT NULL,
    `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment') NOT NULL,
    `entity_id` VARCHAR(64) NOT NULL,
    `field_name` VARCHAR(64) NOT NULL,
    `value` TEXT NOT NULL,
    `actor_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `field_override_entity_type_entity_id_field_name_key`(`entity_type`, `entity_id`, `field_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `suppression` (
    `id` VARCHAR(64) NOT NULL,
    `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment') NOT NULL,
    `entity_id` VARCHAR(64) NOT NULL,
    `contributor_cwid` VARCHAR(32) NULL,
    `reason` TEXT NOT NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_by` VARCHAR(32) NULL,
    `revoked_at` DATETIME(3) NULL,

    INDEX `suppression_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

