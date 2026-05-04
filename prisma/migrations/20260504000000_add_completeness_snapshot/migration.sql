-- Phase 6 ANALYTICS-03: Profile completeness snapshot table.
-- One row per weekly cron run. Historical rows kept for trending.
-- belowThreshold = true when completenessPercent < 70 (escalation flag).

CREATE TABLE `completeness_snapshot` (
    `id` VARCHAR(64) NOT NULL,
    `snapshot_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `total_scholars` INTEGER NOT NULL,
    `complete_count` INTEGER NOT NULL,
    `completeness_percent` DOUBLE NOT NULL,
    `below_threshold` BOOLEAN NOT NULL,

    INDEX `completeness_snapshot_snapshot_at_idx`(`snapshot_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
