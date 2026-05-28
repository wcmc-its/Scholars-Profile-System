-- Feedback badge (#538, docs/feedback-badge-spec.md PR-1) — additive only.
-- Creates the feedback_submission table + the four enums that back it.
-- No FK to scholar (mirrors field_override / suppression — submitter may name
-- a cwid not in scholar or no cwid at all).

-- CreateTable
CREATE TABLE `feedback_submission` (
    `id` VARCHAR(64) NOT NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `mode` ENUM('contextual', 'generic') NOT NULL,
    `page_url` TEXT NULL,
    `page_route` VARCHAR(255) NULL,
    `cwid` VARCHAR(32) NULL,
    `purpose` ENUM('lookup_person', 'lookup_topic', 'browse_unit', 'research_story', 'evaluate_scholars', 'other') NULL,
    `purpose_other` VARCHAR(200) NULL,
    `task_success` ENUM('yes_completely', 'mostly', 'partially', 'no', 'not_looking') NULL,
    `task_failure_intent` VARCHAR(500) NULL,
    `usefulness` TINYINT NULL,
    `what_helped` VARCHAR(500) NULL,
    `what_missing` VARCHAR(500) NULL,
    `accuracy` TINYINT NULL,
    `one_change` VARCHAR(500) NULL,
    `would_use_again` TINYINT NULL,
    `role` ENUM('wcm_faculty', 'wcm_trainee', 'wcm_staff', 'external_researcher', 'journalist', 'patient_or_public', 'prefer_not_say', 'other') NULL,
    `role_other` VARCHAR(100) NULL,
    `consent` BOOLEAN NOT NULL,
    `consent_version` VARCHAR(16) NOT NULL,
    `contact_email` VARCHAR(255) NULL,
    `followup_optin` BOOLEAN NOT NULL DEFAULT false,

    INDEX `feedback_submission_submitted_at_idx`(`submitted_at`),
    INDEX `feedback_submission_cwid_submitted_at_idx`(`cwid`, `submitted_at`),
    INDEX `feedback_submission_page_route_submitted_at_idx`(`page_route`, `submitted_at`),
    INDEX `feedback_submission_mode_submitted_at_idx`(`mode`, `submitted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
