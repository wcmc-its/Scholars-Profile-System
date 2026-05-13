-- CreateTable
CREATE TABLE `postdoc_mentor_relationship` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `mentee_first_name` VARCHAR(64) NULL,
    `mentee_last_name` VARCHAR(64) NULL,
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `title` VARCHAR(128) NULL,
    `status` VARCHAR(32) NOT NULL,
    `program_type` VARCHAR(16) NOT NULL DEFAULT 'POSTDOC',
    `external_id` VARCHAR(64) NOT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'ED-EMPLOYEE-SOR',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `postdoc_mentor_relationship_external_id_key`(`external_id`),
    INDEX `postdoc_mentor_relationship_mentor_cwid_idx`(`mentor_cwid`),
    INDEX `postdoc_mentor_relationship_mentee_cwid_idx`(`mentee_cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
