-- Phase: Browse hub redesign — DB-backed Centers & Institutes.
-- Cross-disciplinary research centers (Englander IPM, Meyer Cancer Center, etc.)
-- spanning departments. Membership joins land later (e.g. reporting_cancer_center).

CREATE TABLE `center` (
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `director_cwid` VARCHAR(32) NULL,
    `scholar_count` INTEGER NOT NULL DEFAULT 0,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(32) NOT NULL DEFAULT 'seed',
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `center_slug_key`(`slug`),
    INDEX `center_slug_idx`(`slug`),
    INDEX `center_sort_order_idx`(`sort_order`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
