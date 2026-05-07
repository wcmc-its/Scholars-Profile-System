-- Per-scholar membership in a Center. Sourced from manual exports
-- (data/center-members/<slug>.txt) until upstream systems land.

CREATE TABLE `center_membership` (
    `center_code` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'manual',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `center_membership_cwid_idx`(`cwid`),
    PRIMARY KEY (`center_code`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `center_membership`
ADD CONSTRAINT `center_membership_center_code_fkey`
FOREIGN KEY (`center_code`) REFERENCES `center`(`code`)
ON DELETE CASCADE ON UPDATE CASCADE;
