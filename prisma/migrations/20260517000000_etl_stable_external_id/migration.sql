-- AlterTable
ALTER TABLE `appointment` MODIFY `external_id` VARCHAR(128) NOT NULL;

-- AlterTable
ALTER TABLE `education` MODIFY `external_id` VARCHAR(128) NOT NULL;

-- AlterTable
ALTER TABLE `grant` MODIFY `external_id` VARCHAR(128) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `appointment_external_id_key` ON `appointment`(`external_id`);

-- CreateIndex
CREATE UNIQUE INDEX `education_external_id_key` ON `education`(`external_id`);

-- CreateIndex
CREATE UNIQUE INDEX `grant_external_id_key` ON `grant`(`external_id`);
