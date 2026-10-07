-- Nickname-only CWID suggestions on Faculty Review Tool mentees (/edit Mentees).
-- Additive nullable column; the running image never selects it.

-- AlterTable
ALTER TABLE `frt_mentee` ADD COLUMN `suggested_cwid` VARCHAR(32) NULL;
