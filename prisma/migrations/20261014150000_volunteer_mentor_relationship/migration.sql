-- ED volunteers (and interns, whom ED records as volunteers) paired with the
-- faculty sponsor / manager on their affiliate role record. Additive DDL only:
-- a new table nothing reads until the image that writes it ships.

-- CreateTable
CREATE TABLE `volunteer_mentor_relationship` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `mentee_first_name` VARCHAR(64) NULL,
    `mentee_last_name` VARCHAR(64) NULL,
    `mentor_role` VARCHAR(16) NOT NULL,
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `status` VARCHAR(32) NULL,
    `external_id` VARCHAR(64) NOT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED-AFFILIATE-SOR',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `volunteer_mentor_relationship_external_id_key`(`external_id`),
    INDEX `volunteer_mentor_relationship_mentor_cwid_idx`(`mentor_cwid`),
    INDEX `volunteer_mentor_relationship_mentee_cwid_idx`(`mentee_cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
