-- CTSC roster sync: per-record CWID problems for the CTSC team to fix at the
-- source. Full-replaced nightly by etl/ctsc-roster; additive, no backfill.
CREATE TABLE `ctsc_feed_issue` (
  `primary_key` INTEGER NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `institution` VARCHAR(255) NULL,
  `feed_cwid` VARCHAR(64) NULL,
  `reason` VARCHAR(32) NOT NULL,
  `suggested_cwid` VARCHAR(32) NULL,
  `suggested_name` VARCHAR(255) NULL,
  `matched_email` VARCHAR(255) NULL,
  `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `ctsc_feed_issue_reason_idx`(`reason`),
  PRIMARY KEY (`primary_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
