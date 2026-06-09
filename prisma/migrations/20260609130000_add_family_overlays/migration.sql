-- CreateTable
CREATE TABLE `family_suppression_overlay` (
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `source_note` TEXT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`supercategory`, `family_label`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `family_sensitivity_overlay` (
    `supercategory` VARCHAR(128) NOT NULL,
    `family_label` VARCHAR(255) NOT NULL,
    `source_note` TEXT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`supercategory`, `family_label`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
