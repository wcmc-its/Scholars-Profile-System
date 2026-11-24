-- Program roster: trainees in an internal program (a summer fellowship, an
-- internship) and their mentors, kept by the program's own staff on /edit.
-- Internal only, hand-entered, no ETL writer. Additive; no data here.
--
-- No foreign key to `scholar`: an intern may hold a CWID and no Scholar row,
-- and a departure must not delete history.

-- CreateTable
CREATE TABLE `roster_program` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `short_label` VARCHAR(32) NOT NULL,
    `description` VARCHAR(1000) NULL,
    `retired_at` DATETIME(3) NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `roster_program_short_label_key`(`short_label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roster_entry` (
    `id` VARCHAR(64) NOT NULL,
    `program_id` VARCHAR(64) NOT NULL,
    `mentee_cwid` VARCHAR(32) NOT NULL,
    `mentee_name` VARCHAR(255) NOT NULL,
    `year` SMALLINT NOT NULL,
    `research_program` VARCHAR(255) NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `roster_entry_mentee_cwid_idx`(`mentee_cwid`),
    UNIQUE INDEX `roster_entry_program_id_mentee_cwid_year_key`(`program_id`, `mentee_cwid`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roster_entry_mentor` (
    `entry_id` VARCHAR(64) NOT NULL,
    `mentor_cwid` VARCHAR(32) NOT NULL,
    `mentor_name` VARCHAR(255) NOT NULL,

    INDEX `roster_entry_mentor_mentor_cwid_idx`(`mentor_cwid`),
    PRIMARY KEY (`entry_id`, `mentor_cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `roster_entry` ADD CONSTRAINT `roster_entry_program_id_fkey` FOREIGN KEY (`program_id`) REFERENCES `roster_program`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `roster_entry_mentor` ADD CONSTRAINT `roster_entry_mentor_entry_id_fkey` FOREIGN KEY (`entry_id`) REFERENCES `roster_entry`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
