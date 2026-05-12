-- CreateTable
CREATE TABLE `phd_mentor_relationship` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `mentor_first_name` VARCHAR(64) NULL,
    `mentor_last_name` VARCHAR(64) NULL,
    `mentor_email` VARCHAR(128) NULL,
    `mentor_department` VARCHAR(128) NULL,
    `mentor_institution` VARCHAR(255) NULL,
    `mentee_first_name` VARCHAR(64) NULL,
    `mentee_last_name` VARCHAR(64) NULL,
    `conferral_year` INTEGER NULL,
    `major_desc` VARCHAR(128) NULL,
    `advisor_status` CHAR(1) NOT NULL,
    `program_type` VARCHAR(16) NOT NULL,
    `external_id` VARCHAR(64) NOT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'JENZABAR-MAJSP',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `phd_mentor_relationship_external_id_key`(`external_id`),
    INDEX `phd_mentor_relationship_mentor_cwid_idx`(`mentor_cwid`),
    INDEX `phd_mentor_relationship_mentee_cwid_idx`(`mentee_cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
