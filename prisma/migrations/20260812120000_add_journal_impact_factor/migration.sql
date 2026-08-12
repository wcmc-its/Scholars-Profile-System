-- CreateTable
CREATE TABLE `journal_impact_factor` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `journal_title` VARCHAR(200) NOT NULL,
    `journal_abbrev` VARCHAR(128) NOT NULL,
    `issn` VARCHAR(12) NULL,
    `eissn` VARCHAR(12) NULL,
    `impact_score_1` DECIMAL(7, 1) NULL,
    `impact_score_2` DECIMAL(7, 1) NULL,
    `category` VARCHAR(200) NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `journal_impact_factor_journal_abbrev_key`(`journal_abbrev`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
