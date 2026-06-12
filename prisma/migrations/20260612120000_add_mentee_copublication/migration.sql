-- CreateTable
CREATE TABLE `mentee_copublication` (
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `copub_count` INTEGER NOT NULL,
    `preview` JSON NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`mentor_cwid`, `mentee_cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
