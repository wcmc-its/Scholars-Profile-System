-- #160 follow-up — add `mentee` to the shared `EntityType` ENUM.
--
-- A mentor↔mentee relationship is derived (no FK; truncate-rebuilt nightly from
-- Jenzabar / Employee Central via the reporting DB). A mentor may HIDE a mentee
-- from their public profile — a whole-entity suppression keyed on
-- `entity_id = "{mentorCwid}:{menteeCwid}"`, owner = the mentor (substring
-- before the colon). Mentees are suppression-only; they are never a
-- `field_override` or `unit_admin` target.
--
-- Prisma shares ONE `EntityType` enum across `field_override`, `suppression`,
-- and `unit_admin`, so all three columns are widened to keep the client and the
-- DB in sync (mirrors the #540 unit-curation migration, which extended the same
-- three for department/division/center). The change is additive: a widened ENUM
-- does not invalidate any stored value, and `MODIFY` an enum column that is part
-- of a composite PK (`unit_admin`) is a no-data-conversion metadata change.
--
-- See also: scripts/sql/audit-log.sql — the audit log's `target_entity_type`
-- ENUM is extended with `mentee` in the same PR (separate database, separate
-- file).

-- AlterTable
ALTER TABLE `field_override` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee') NOT NULL;

-- AlterTable
ALTER TABLE `suppression` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee') NOT NULL;

-- AlterTable
ALTER TABLE `unit_admin` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee') NOT NULL;
