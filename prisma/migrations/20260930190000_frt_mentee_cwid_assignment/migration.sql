-- Hand-assigned CWIDs on Faculty Review Tool mentees (/edit Mentees). Additive
-- nullable columns; the running image never selects them.

-- AlterTable
ALTER TABLE `frt_mentee` ADD COLUMN `cwid_assigned_at` DATETIME(3) NULL,
    ADD COLUMN `cwid_assigned_by` VARCHAR(32) NULL;
