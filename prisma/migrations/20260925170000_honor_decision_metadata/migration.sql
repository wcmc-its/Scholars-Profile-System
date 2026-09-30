-- Honors approval queue (#1762 follow-up): record who decided a row and when,
-- an optional rejection reason, and which approved sibling auto-rejected a row.
-- These back the queue's Undo (revert to pending, restoring the siblings an
-- approval rejected), the Rejected tab's Reason column, and "by <curator>".
-- All four columns are nullable: rows decided before this migration keep NULL
-- (the UI shows no reason / no curator, and undo refuses them). Additive DDL
-- only; the running app image never selects these columns by name.

-- AlterTable
ALTER TABLE `honor` ADD COLUMN `decided_by_cwid` VARCHAR(32) NULL,
    ADD COLUMN `decided_at` DATETIME(3) NULL,
    ADD COLUMN `rejection_reason` VARCHAR(255) NULL,
    ADD COLUMN `superseded_by_id` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `honor_superseded_by_id_idx` ON `honor`(`superseded_by_id`);
