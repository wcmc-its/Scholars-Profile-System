-- #1609 — "Grants for me" save / not-relevant feedback (SELF_EDIT_GRANT_RECS).
-- New table only (additive); the running app image never reads it, so this can
-- land ahead of the image. Covered by app_rw's existing DML grant on
-- `scholars`.* — no grant change.

-- CreateTable
CREATE TABLE `grant_rec_feedback` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cwid` VARCHAR(32) NOT NULL,
    `opportunity_id` VARCHAR(128) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `reason` VARCHAR(24) NULL,
    `actor_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `grant_rec_feedback_opportunity_id_idx`(`opportunity_id`),
    UNIQUE INDEX `grant_rec_feedback_cwid_opportunity_id_key`(`cwid`, `opportunity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
