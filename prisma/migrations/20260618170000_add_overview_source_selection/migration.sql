-- CreateTable
CREATE TABLE `overview_source_selection` (
    `cwid` VARCHAR(32) NOT NULL,
    `deltas` JSON NOT NULL,
    `updated_by_cwid` VARCHAR(32) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `overview_source_selection` ADD CONSTRAINT `overview_source_selection_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
