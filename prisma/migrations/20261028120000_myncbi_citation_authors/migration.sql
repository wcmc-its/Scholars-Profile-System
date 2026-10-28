-- Author list per MyNCBI citation, so report 16 can tell a scholar's own papers
-- from the ones they linked to a grant. Additive and nullable: rows fetched before
-- this column read as unknown until their next fetch.

-- AlterTable
ALTER TABLE `myncbi_citation` ADD COLUMN `authors` TEXT NULL;
