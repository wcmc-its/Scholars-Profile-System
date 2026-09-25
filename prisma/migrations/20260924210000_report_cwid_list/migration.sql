-- Report 8 (Article counts) "CWID list" filter: a pasted list of CWIDs is
-- stored once and the report URL carries its id (`list=<id>`), since a
-- 1,500-CWID list does not fit in a URL. Rows are never updated or deleted by
-- the app, so a shared link keeps meaning the same people. DDL only (#584:
-- migrations never INSERT).

-- CreateTable
CREATE TABLE `report_cwid_list` (
    `id` VARCHAR(32) NOT NULL,
    `cwids` JSON NOT NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
