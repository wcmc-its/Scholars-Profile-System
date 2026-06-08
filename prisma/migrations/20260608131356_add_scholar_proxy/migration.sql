-- CreateTable
CREATE TABLE `scholar_proxy` (
    `scholar_cwid` VARCHAR(32) NOT NULL,
    `proxy_cwid` VARCHAR(32) NOT NULL,
    `granted_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scholar_proxy_proxy_cwid_idx`(`proxy_cwid`),
    PRIMARY KEY (`scholar_cwid`, `proxy_cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

