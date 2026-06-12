-- CreateTable
CREATE TABLE `publication_citing` (
    `pmid` INTEGER NOT NULL,
    `total` INTEGER NOT NULL,
    `citing_pubs` JSON NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
