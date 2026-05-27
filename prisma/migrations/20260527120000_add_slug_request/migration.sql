-- CreateTable
CREATE TABLE `slug_request` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `requested_slug` VARCHAR(255) NOT NULL,
    `reason` TEXT NULL,
    `status` ENUM('pending', 'approved', 'rejected', 'superseded', 'withdrawn') NOT NULL DEFAULT 'pending',
    `requested_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_by` VARCHAR(32) NULL,
    `decided_at` DATETIME(3) NULL,
    `decision_note` TEXT NULL,

    INDEX `slug_request_status_created_at_idx`(`status`, `created_at`),
    INDEX `slug_request_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

