-- #3071 WCM directory namesake counts. Additive DDL only: a new table that
-- nothing reads until the image that writes it ships (etl/ed, etl/reporter-grants).

-- CreateTable
-- Per name-only scholar: other WCM directory people who share their name and
-- could hold an NIH award. A count, never who they are.
CREATE TABLE `wcm_namesake` (
    `cwid` VARCHAR(32) NOT NULL,
    `namesake_count` INTEGER NOT NULL,
    `checked_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `wcm_namesake` ADD CONSTRAINT `wcm_namesake_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
