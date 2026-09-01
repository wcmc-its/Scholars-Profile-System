-- #2542 contract B — drop the legacy per-unit leader columns and the retired
-- role-vocabulary tables, then close `center_membership`'s role-vocabulary FK
-- onto the shared, per-kind vocabulary.
--
-- ============================================================================
-- DATA-LOSS HAZARD — this DROPs four columns and two tables with no reversible
-- rollback. Confirmed safe at authoring time (2026-09-01):
--
--   - `department.chair_cwid`, `division.chief_cwid`, `center.director_cwid`,
--     `center.leader_interim` — every reader/writer of these four columns was
--     retired in #2542 contract A (7c51e875, already merged to master).
--     `OrgUnitRoleAssignment` has been the sole leadership store since that
--     deploy; the columns have been dead weight since then.
--   - `center_role` / `center_leader` — 0 rows in every environment. Nothing
--     was ever migrated out of them, because nothing was ever migrated into
--     them: see `20260829143000_center_role_vocabulary`'s and
--     `20260830150000_org_unit_role_vocabulary`'s headers (staging verified
--     2026-08-30, 0 rows in both).
--   - `center_membership` role-vocabulary FK (step below) — a read-only probe
--     on 2026-09-01 found 0 `center_membership` rows whose
--     (`role_entity_type`, `membership_role_key`) has no matching
--     `org_unit_role` row, 0 rows with a null `role_entity_type`, and legacy
--     membership-type counts equal to `org_unit_role_assignment` assignment
--     counts, in both envs.
--
-- FK / DROP ORDER — confirmed from migration history, not guessed:
--   - `center_leader_center_code_role_key_fkey`
--     (`prisma/migrations/20260829143000_center_role_vocabulary/
--     migration.sql:78`) points `center_leader` -> `center_role`, so
--     `center_leader` (the referencing table) is dropped first; dropping
--     `center_role` (the referenced table) first would fail on the live FK.
--   - `center_membership`'s own FK to `center_role`
--     (`center_membership_center_code_membership_role_key_fkey`) was already
--     dropped, along with its supporting index, in
--     `prisma/migrations/20260830150000_org_unit_role_vocabulary/
--     migration.sql:86-87` — nothing currently FKs `center_membership` to
--     either table dropped below, so no ordering constraint from that side.
--
-- Every reader/writer of `center_role`/`center_leader` was migrated onto
-- `org_unit_role`/`org_unit_role_assignment` no later than
-- `20260830150000_org_unit_role_vocabulary` — nothing in the application
-- reads or writes either table by the time this migration runs.
--
-- Hand-written. `prisma migrate diff` is unusable in this repo: it emits ~44
-- unrelated `MODIFY ... JSON` statements on an UNMODIFIED master checkout —
-- see `prisma/migrations/20260901120000_drop_center_program_leader/
-- migration.sql` for the same note against the same Prisma version.
-- ============================================================================

-- AlterTable
ALTER TABLE `department` DROP COLUMN `chair_cwid`;

-- AlterTable
ALTER TABLE `division` DROP COLUMN `chief_cwid`;

-- AlterTable
ALTER TABLE `center` DROP COLUMN `director_cwid`, DROP COLUMN `leader_interim`;

-- DropTable
DROP TABLE `center_leader`;

-- DropTable
DROP TABLE `center_role`;

-- CreateIndex
CREATE INDEX `center_membership_role_entity_type_membership_role_key_idx` ON `center_membership`(`role_entity_type`, `membership_role_key`);

-- AddForeignKey
ALTER TABLE `center_membership` ADD CONSTRAINT `center_membership_role_entity_type_membership_role_key_fkey` FOREIGN KEY (`role_entity_type`, `membership_role_key`) REFERENCES `org_unit_role`(`entity_type`, `key`) ON DELETE NO ACTION ON UPDATE NO ACTION;
