-- Center program leaders (#1117).
--
-- A center program may be CO-LED, which the single `center_program.leader_cwid`
-- column (added in #1105) could not represent. Leaders move to their own table
-- (0..N rows per program), each with an `interim` qualifier and a `sort_order`
-- for display order. The two single-leader columns are then dropped — the
-- program-page feature is dark (gated `CENTER_PROGRAM_PAGES`) and no environment
-- has ever set a program leader (there was no edit UI; the backfill only set
-- member `program_code`), so this is a clean cutover with no data to migrate.

-- CreateTable
CREATE TABLE `center_program_leader` (
    `center_code` VARCHAR(64) NOT NULL,
    `program_code` VARCHAR(16) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `interim` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`center_code`, `program_code`, `cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `center_program_leader` ADD CONSTRAINT `center_program_leader_center_code_program_code_fkey` FOREIGN KEY (`center_code`, `program_code`) REFERENCES `center_program`(`center_code`, `code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- DropColumn — the single-leader columns (#1105) are superseded by the table above.
ALTER TABLE `center_program` DROP COLUMN `leader_cwid`;
ALTER TABLE `center_program` DROP COLUMN `leader_interim`;
