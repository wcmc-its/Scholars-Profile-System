-- #1570 — a role qualifier on a center program's leader row. "leader" (the
-- default, a program lead) or "coe_liaison" (the Community Outreach & Engagement
-- liaison, rendered as a separate "COE Liaison" card AFTER the leaders on the
-- program page). Additive, NOT NULL with a 'leader' default, so every existing
-- CenterProgramLeader row backfills to "leader" and no reader changes behavior
-- until liaison rows are seeded. A plain VARCHAR (not an enum) to keep the
-- migration minimal.

-- AlterTable
ALTER TABLE `center_program_leader` ADD COLUMN `role` VARCHAR(32) NOT NULL DEFAULT 'leader';
