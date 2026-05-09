-- Issue #90 — mapping from a WCM scholar's CWID to their NIH RePORTER PI
-- profile_id, for the outbound "View NIH portfolio on RePORTER" link in
-- the Funding section header. Composite PK supports the rare scholar with
-- multiple legacy eRA Commons accounts; exactly one row per cwid carries
-- is_preferred = true and is what the UI link uses.
CREATE TABLE `person_nih_profile` (
    `cwid` VARCHAR(32) NOT NULL,
    `nih_profile_id` INTEGER NOT NULL,
    `is_preferred` BOOLEAN NOT NULL DEFAULT false,
    `first_seen` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_verified` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `source` VARCHAR(32) NOT NULL DEFAULT 'RePORTER',
    `resolution_source` VARCHAR(32) NOT NULL,

    INDEX `person_nih_profile_cwid_is_preferred_idx`(`cwid`, `is_preferred`),
    PRIMARY KEY (`cwid`, `nih_profile_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `person_nih_profile` ADD CONSTRAINT `person_nih_profile_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
