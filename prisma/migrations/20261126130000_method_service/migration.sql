-- Method services: a service a department or a core offers for one or more
-- research methods, kept by the unit's own editors on /edit. Hand-entered, no
-- ETL writer. Additive; no data here.
--
-- No foreign key on (`entity_type`, `entity_id`): the owning unit is
-- polymorphic, as it is on `unit_admin`.

-- CreateTable
CREATE TABLE `method_service` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit', 'institution') NOT NULL,
    `entity_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `families` JSON NOT NULL,
    `supported_pmids` JSON NOT NULL,
    `excluded_pmids` JSON NOT NULL,
    `count_staff_papers` BOOLEAN NOT NULL DEFAULT false,
    `added_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `method_service_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
