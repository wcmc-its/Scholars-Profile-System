-- CreateTable
CREATE TABLE `reciter_pending_pmid` (
    `cwid` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`cwid`, `pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
