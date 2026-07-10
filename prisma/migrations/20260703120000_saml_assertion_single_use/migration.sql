-- CreateTable
CREATE TABLE `saml_assertion_seen` (
    `id` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_saml_assertion_seen_expires_at`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

