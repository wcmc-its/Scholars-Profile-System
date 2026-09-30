-- #2542 Phase 1 — per-center role vocabulary (`center_role`), leadership
-- assignments (`center_leader`), and the membership-role key that
-- `center_membership.membership_type` becomes derived from.
--
-- Leadership is its OWN table, not two more columns on `center_membership`:
-- a leader need not be a member (#2542 decision 7 — 9 of the Cornell Health
-- Policy Center's 77 people hold only a leadership role), and
-- `center_membership` is keyed `(center_code, cwid)`, so putting leadership
-- there would file those people as members and skew every count that reads the
-- table. See the model doc in schema.prisma.
--
-- EXPAND ONLY. `center.director_cwid` and `center.leader_interim` are NOT
-- dropped here: CONTRIBUTING.md § "Every migration is additive" forbids
-- dropping a column in the same deploy as the code that stopped reading it,
-- and migrations run BEFORE the ECS service rolls (DEPLOY-RUNBOOK.md § 5-6).
-- For that same reason the app DUAL-READS (`center_leader` ?? the column) and
-- DUAL-WRITES both during this release, so the window between the roll and the
-- manual backfill is not an outage and an app-code rollback still works. The
-- fallback, the dual-write and the DROP all ship in the contract PR.
--
-- NO DATA HERE, deliberately. `center_role.center_code` FKs to `center`, which
-- is EMPTY when `prisma migrate deploy` runs against CI's fresh database and on
-- the #445 prod-bootstrap path — an in-migration seed would die with MySQL 1452
-- (the #584 regression that `tests/unit/migrations-empty-db-safe.test.ts`
-- exists to prevent). The vocabulary seed and the leadership backfill live in
-- `scripts/backfills/2026-08-29-center-role-vocabulary.ts`.
--
-- `key` / `role_group` / `scope` are VARCHAR with app-level closure rather than
-- MySQL ENUMs, matching `center_program_leader.role` and `core_leader.role` —
-- Phase 3 lets curators mint entries, and each new value must not cost an
-- `ALTER TABLE … MODIFY ENUM`.

-- AlterTable
ALTER TABLE `center_membership` ADD COLUMN `membership_role_key` VARCHAR(32) NULL;

-- CreateTable
CREATE TABLE `center_role` (
    `center_code` VARCHAR(64) NOT NULL,
    `key` VARCHAR(32) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `role_group` VARCHAR(16) NOT NULL,
    `scope` VARCHAR(16) NOT NULL DEFAULT 'center',
    `single_holder` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `profile_title` BOOLEAN NOT NULL DEFAULT true,
    `expansion` VARCHAR(255) NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'seed',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `center_role_center_code_role_group_sort_order_idx`(`center_code`, `role_group`, `sort_order`),
    PRIMARY KEY (`center_code`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `center_leader` (
    `center_code` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `role_key` VARCHAR(32) NOT NULL,
    `interim` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `qualifier` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `center_leader_cwid_idx`(`cwid`),
    INDEX `center_leader_center_code_role_key_sort_order_idx`(`center_code`, `role_key`, `sort_order`),
    PRIMARY KEY (`center_code`, `cwid`, `role_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `center_role` ADD CONSTRAINT `center_role_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `center_leader` ADD CONSTRAINT `center_leader_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `center_leader` ADD CONSTRAINT `center_leader_center_code_role_key_fkey` FOREIGN KEY (`center_code`, `role_key`) REFERENCES `center_role`(`center_code`, `key`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `center_membership` ADD CONSTRAINT `center_membership_center_code_membership_role_key_fkey` FOREIGN KEY (`center_code`, `membership_role_key`) REFERENCES `center_role`(`center_code`, `key`) ON DELETE NO ACTION ON UPDATE NO ACTION;

