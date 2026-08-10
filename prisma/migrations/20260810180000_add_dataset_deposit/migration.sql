-- AlterTable
ALTER TABLE `unit_admin` DROP PRIMARY KEY,
    MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit') NOT NULL,
    ADD PRIMARY KEY (`entity_type`, `entity_id`, `cwid`);

-- AlterTable
ALTER TABLE `field_override` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit') NOT NULL;

-- AlterTable
ALTER TABLE `suppression` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit') NOT NULL;

-- CreateTable
CREATE TABLE `dataset_deposit` (
    `id` VARCHAR(64) NOT NULL,
    `repository` VARCHAR(64) NOT NULL,
    `accession_or_doi` VARCHAR(255) NOT NULL,
    `resource_type` VARCHAR(32) NULL,
    `data_type` VARCHAR(64) NULL,
    `access_model` VARCHAR(16) NULL,
    `deposit_year` INTEGER NULL,
    `provenance` VARCHAR(16) NOT NULL,
    `confidence` VARCHAR(16) NULL,
    `source` VARCHAR(48) NOT NULL DEFAULT 'reciterdb.dataset_deposit',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `dataset_deposit_repository_accession_or_doi_key`(`repository`, `accession_or_doi`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `person_dataset_deposit` (
    `cwid` VARCHAR(32) NOT NULL,
    `dataset_id` VARCHAR(64) NOT NULL,
    `author_position` VARCHAR(16) NOT NULL,
    `pmids` JSON NOT NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `person_dataset_deposit_cwid_idx`(`cwid`),
    INDEX `person_dataset_deposit_dataset_id_idx`(`dataset_id`),
    PRIMARY KEY (`cwid`, `dataset_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `person_dataset_deposit` ADD CONSTRAINT `person_dataset_deposit_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `person_dataset_deposit` ADD CONSTRAINT `person_dataset_deposit_dataset_id_fkey` FOREIGN KEY (`dataset_id`) REFERENCES `dataset_deposit`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
