-- CreateTable
CREATE TABLE `cancer_center_disease_assignment` (
    `cwid` VARCHAR(32) NOT NULL,
    `disease_code` VARCHAR(32) NOT NULL,
    `rank` INTEGER NOT NULL,
    `focus` VARCHAR(16) NOT NULL,
    `confidence` VARCHAR(16) NOT NULL,
    `lead_pubs` INTEGER NOT NULL,
    `second_pubs` INTEGER NOT NULL,
    `middle_pubs` INTEGER NOT NULL,
    `grants_led` INTEGER NOT NULL,
    `grants_support` INTEGER NOT NULL,
    `trials_led` INTEGER NOT NULL,
    `trials_support` INTEGER NOT NULL,
    `pub_score` INTEGER NOT NULL,
    `score` INTEGER NOT NULL,
    `first_year` INTEGER NULL,
    `last_year` INTEGER NULL,
    `recent_pubs` INTEGER NOT NULL,
    `specialty_status` VARCHAR(24) NOT NULL,
    `run_id` VARCHAR(64) NOT NULL,

    INDEX `cancer_center_disease_assignment_cwid_idx`(`cwid`),
    PRIMARY KEY (`cwid`, `disease_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cancer_center_disease_decision` (
    `cwid` VARCHAR(32) NOT NULL,
    `disease_code` VARCHAR(32) NOT NULL,
    `decision` VARCHAR(16) NOT NULL,
    `decided_by` VARCHAR(32) NOT NULL,
    `decided_at` DATETIME(3) NOT NULL,
    `score_at_decision` INTEGER NOT NULL,
    `confidence_at_decision` VARCHAR(16) NOT NULL,

    INDEX `cancer_center_disease_decision_cwid_idx`(`cwid`),
    PRIMARY KEY (`cwid`, `disease_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

