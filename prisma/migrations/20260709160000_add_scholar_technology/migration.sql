-- CreateTable
CREATE TABLE `scholar_technology` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `reference` VARCHAR(32) NULL,
    `title` TEXT NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scholar_technology_cwid_idx`(`cwid`),
    UNIQUE INDEX `scholar_technology_cwid_url_key`(`cwid`, `url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scholar_technology` ADD CONSTRAINT `scholar_technology_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
