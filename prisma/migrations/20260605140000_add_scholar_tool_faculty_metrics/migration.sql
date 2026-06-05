-- AlterTable
ALTER TABLE `scholar` ADD COLUMN `first_author_count` INTEGER NULL,
    ADD COLUMN `h_index` INTEGER NULL,
    ADD COLUMN `last_author_count` INTEGER NULL,
    ADD COLUMN `scored_pub_count` INTEGER NULL;

-- CreateTable
CREATE TABLE `scholar_tool` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `tool_name` VARCHAR(255) NOT NULL,
    `category` VARCHAR(128) NULL,
    `pmid_count` INTEGER NOT NULL,
    `max_confidence` DECIMAL(5, 4) NOT NULL,
    `sample_context` TEXT NULL,
    `pmids` JSON NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scholar_tool_cwid_pmid_count_idx`(`cwid`, `pmid_count` DESC),
    UNIQUE INDEX `scholar_tool_cwid_tool_name_key`(`cwid`, `tool_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scholar_tool` ADD CONSTRAINT `scholar_tool_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
