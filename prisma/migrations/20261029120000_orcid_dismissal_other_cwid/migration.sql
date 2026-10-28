-- ORCID queue v3 B2. Additive DDL only: the scholar an iD was confirmed for
-- when a librarian ruled it out as belonging to someone else.

-- AlterTable
ALTER TABLE `orcid_dismissal` ADD COLUMN `other_cwid` VARCHAR(32) NULL;
