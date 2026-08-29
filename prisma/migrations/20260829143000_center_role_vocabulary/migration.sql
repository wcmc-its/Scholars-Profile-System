-- #2542 Phase 1 — per-center role vocabulary, and the assignment columns that
-- reference it (`docs/` issue #2542 § "The model: one per-unit role
-- vocabulary, in two groups").
--
-- EXPAND ONLY. `center.director_cwid` and `center.leader_interim` are NOT
-- dropped here: CONTRIBUTING.md § "Every migration is additive" forbids
-- dropping a column in the same deploy as the code that stopped reading it,
-- and migrations run BEFORE the ECS service rolls (DEPLOY-RUNBOOK.md § 5-6),
-- so the previous image would 500 the public center page for the whole
-- rollout window. The DROP ships as a separate contract migration once the
-- backfill below is verified in prod. There is no rollback (CONTRIBUTING.md).
--
-- NO DATA HERE, deliberately. `center_role.center_code` FKs to `center`, which
-- is EMPTY when `prisma migrate deploy` runs against CI's fresh database and on
-- the #445 prod-bootstrap path — an in-migration seed would die with MySQL 1452
-- (the #584 regression that `tests/unit/migrations-empty-db-safe.test.ts`
-- exists to prevent). The vocabulary seed and the director backfill both live
-- in `scripts/backfills/2026-08-29-center-role-vocabulary.ts`, run manually
-- after this migration lands. Until it runs, every new column reads NULL and
-- no behaviour changes.
--
-- `key` / `role_group` / `scope` are VARCHAR with app-level closure rather than
-- MySQL ENUMs, matching `center_program_leader.role` and `core_leader.role` —
-- Phase 3 lets curators mint entries, and each new value must not cost an
-- `ALTER TABLE … MODIFY ENUM`.
--
-- Both membership FKs are NO ACTION for the same reason as the existing
-- `program` FK: the key is composite and `center_code` is NOT NULL, so SET NULL
-- would try to null `center_code` too and is invalid in Prisma and MySQL alike.

-- AlterTable
ALTER TABLE `center_membership` ADD COLUMN `leadership_interim` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `leadership_qualifier` VARCHAR(255) NULL,
    ADD COLUMN `leadership_role_key` VARCHAR(32) NULL,
    ADD COLUMN `leadership_sort_order` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `membership_role_key` VARCHAR(32) NULL;

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

-- CreateIndex
CREATE INDEX `center_membership_center_code_leadership_role_key_idx` ON `center_membership`(`center_code`, `leadership_role_key`);

-- AddForeignKey
ALTER TABLE `center_role` ADD CONSTRAINT `center_role_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `center_membership` ADD CONSTRAINT `center_membership_center_code_membership_role_key_fkey` FOREIGN KEY (`center_code`, `membership_role_key`) REFERENCES `center_role`(`center_code`, `key`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `center_membership` ADD CONSTRAINT `center_membership_center_code_leadership_role_key_fkey` FOREIGN KEY (`center_code`, `leadership_role_key`) REFERENCES `center_role`(`center_code`, `key`) ON DELETE NO ACTION ON UPDATE NO ACTION;

