-- #2542 — move the role vocabulary from PER-UNIT to PER-KIND.
--
-- Phase 1 (20260829143000) keyed the vocabulary `(center_code, key)` and copied
-- the default set onto every center. That made each unit the owner of an
-- editable copy, so one concept could end up with a different word at every
-- unit. Since a superuser / comms_steward owns this vocabulary precisely so the
-- institution speaks with one voice, per-unit copies are a drift generator.
-- Keyed by kind, drift is unrepresentable rather than merely discouraged.
--
-- EXPAND ONLY. `center_role` and `center_leader` are NOT dropped here. They are
-- empty in every environment (staging verified 2026-08-30: 0 rows in both, 0
-- non-null `membership_role_key` of 472 memberships), but migrations run BEFORE
-- the ECS roll (DEPLOY-RUNBOOK steps 5-6), and the still-running previous image
-- SELECTs both on public paths — `lib/api/profile.ts` and `lib/api/centers.ts`.
-- Dropping them here would 500 scholar profiles and center pages for the whole
-- rollout window, with no rollback. The contract migration drops them.
--
-- NO DATA. Seeding lives in scripts/backfills/, never in a migration:
-- `tests/unit/migrations-empty-db-safe.test.ts` fails any `INSERT INTO` here
-- because a fresh CI database has no parent rows (MySQL 1452, the #584
-- regression). The new write paths also seed lazily, so there is no ordering
-- dependency between this deploy and the backfill.
--
-- Hand-written. `prisma migrate diff` is unusable in this repo: it emits 44
-- unrelated `MODIFY ... JSON` statements on an UNMODIFIED master checkout
-- (pre-existing drift between the migration history and schema.prisma under
-- Prisma 7.8). Any generated migration would carry all of them.

-- The vocabulary, one list per unit kind for the whole institution.
CREATE TABLE `org_unit_role` (
    `entity_type`   VARCHAR(32)  NOT NULL,
    `key`           VARCHAR(32)  NOT NULL,
    `label`         VARCHAR(255) NOT NULL,
    `role_group`    VARCHAR(16)  NOT NULL,
    `scope`         VARCHAR(16)  NOT NULL DEFAULT 'unit',
    `single_holder` BOOLEAN      NOT NULL DEFAULT false,
    `sort_order`    INTEGER      NOT NULL DEFAULT 0,
    `profile_title` BOOLEAN      NOT NULL DEFAULT true,
    `expansion`     VARCHAR(255) NULL,
    `source`        VARCHAR(32)  NOT NULL DEFAULT 'seed',
    `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`    DATETIME(3)  NOT NULL,

    INDEX `org_unit_role_entity_type_role_group_sort_order_idx`(`entity_type`, `role_group`, `sort_order`),
    PRIMARY KEY (`entity_type`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Leadership assignments. Polymorphic on (entity_type, entity_id) with NO FK to
-- the unit tables — the same shape and the same reason as `unit_admin`: an
-- assignment is a fact about a unit, not a child row, and an informal unit's
-- synthetic code is known only to the manual layer.
CREATE TABLE `org_unit_role_assignment` (
    `entity_type` VARCHAR(32) NOT NULL,
    `entity_id`   VARCHAR(64) NOT NULL,
    `cwid`        VARCHAR(32) NOT NULL,
    `role_key`    VARCHAR(32) NOT NULL,
    `interim`     BOOLEAN     NOT NULL DEFAULT false,
    `sort_order`  INTEGER     NOT NULL DEFAULT 0,
    `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`  DATETIME(3) NOT NULL,

    INDEX `org_unit_role_assignment_cwid_idx`(`cwid`),
    INDEX `org_unit_role_assignment_entity_type_entity_id_role_key_sort_idx`(`entity_type`, `entity_id`, `role_key`, `sort_order`),
    PRIMARY KEY (`entity_type`, `entity_id`, `cwid`, `role_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Closure IN THE DATABASE: a curator can only ever assign a role a superuser put
-- on the list. Composite on both sides, so the discriminator is carried, not
-- synthesized -- MySQL cannot point a foreign key at a literal.
ALTER TABLE `org_unit_role_assignment`
    ADD CONSTRAINT `org_unit_role_assignment_entity_type_role_key_fkey`
    FOREIGN KEY (`entity_type`, `role_key`)
    REFERENCES `org_unit_role`(`entity_type`, `key`)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The membership half's discriminator. The matching FK is deliberately NOT added
-- here: it would require `org_unit_role` to be seeded before the roll finishes,
-- and migrations run first. It lands in the contract migration, after the
-- backfill. Until then closure is app-level, exactly as it is on master today.
ALTER TABLE `center_membership`
    ADD COLUMN `role_entity_type` VARCHAR(32) NOT NULL DEFAULT 'center';

-- Release the membership row from the per-unit vocabulary. Dropping a CONSTRAINT
-- cannot break the previous image -- it only removes a check -- and it is what
-- lets the new write paths stop seeding `center_role` entirely.
ALTER TABLE `center_membership` DROP FOREIGN KEY `center_membership_center_code_membership_role_key_fkey`;
DROP INDEX `center_membership_center_code_membership_role_key_fkey` ON `center_membership`;
