-- Self-asserted profile appointments (#1568) — internal WCM roles the ED feed
-- omits (Program Director, Head of Section) + current/historical positions at
-- OTHER institutions, entered by a scholar (or a curator on their behalf) on
-- /edit. A SEPARATE table from `appointment` by design: the ED/Jenzabar ETL
-- never touches it (structurally wipe-safe), and it is profile-only by
-- construction (no third-party/aggregate serializer reads it). Additive: a new
-- table FK-cascaded to scholar, no change to existing tables.

-- CreateTable
CREATE TABLE `profile_appointment` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `category` ENUM('WCM_LEADERSHIP', 'EXTERNAL') NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `organization` VARCHAR(255) NOT NULL,
    `unit` VARCHAR(255) NULL,
    `location` VARCHAR(255) NULL,
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `show_on_profile` BOOLEAN NOT NULL DEFAULT true,
    `source` VARCHAR(16) NOT NULL DEFAULT 'SELF',
    `entered_by_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `profile_appointment_cwid_show_on_profile_sort_order_idx`(`cwid`, `show_on_profile`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `profile_appointment` ADD CONSTRAINT `profile_appointment_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
