-- comms_steward display-name bridge (comms-steward-profile-editing-spec.md §5):
-- ED-sourced names for steward CWIDs with no Scholar row of their own, populated
-- by etl:ed:import-steward-names and read by the "View as" banner + candidate
-- list. Additive; an empty table just means names fall back to the CWID.

-- CreateTable
CREATE TABLE `steward_directory` (
    `cwid` VARCHAR(32) NOT NULL,
    `display_name` VARCHAR(255) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
