-- AlterTable
ALTER TABLE `overview_generation` ADD COLUMN `prompt_version` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `overview_generation_prompt_version_created_at_idx` ON `overview_generation`(`prompt_version`, `created_at` DESC);
