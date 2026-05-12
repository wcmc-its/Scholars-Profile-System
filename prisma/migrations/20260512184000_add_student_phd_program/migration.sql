-- CreateTable
CREATE TABLE `student_phd_program` (
    `cwid` VARCHAR(32) NOT NULL,
    `program` VARCHAR(255) NOT NULL,
    `program_code` VARCHAR(32) NULL,
    `expected_grad_year` INTEGER NULL,
    `status` VARCHAR(64) NULL,
    `exit_reason` VARCHAR(128) NULL,
    `start_date` DATETIME(3) NULL,
    `end_date` DATETIME(3) NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
