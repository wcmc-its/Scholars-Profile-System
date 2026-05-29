-- #552 Center management — extended membership model + per-center program taxonomy.
-- Generated offline (`prisma migrate diff --from-schema <HEAD> --to-schema <edited>`),
-- per project_prisma_migration_offline (the local dev DB is drifted; never `migrate dev`).
-- DDL ONLY. This migration must be safe to apply to an empty database (CI `build`
-- runs it against a fresh DB, and it is the #445 prod-bootstrap path). The Meyer
-- Cancer Center program seed is NOT here — `center_program` has a FK to the
-- seed/ETL-owned `center` table, which is empty at `migrate deploy` time, so an
-- INSERT here would violate the FK on a fresh DB (1452). The program rows are seeded
-- idempotently (after the parent center rows) in `prisma/seed-centers.ts` (#584).
-- All four new center_membership columns are NULLABLE: legacy rows read as
-- (null,null,null,null) = "active forever, unclassified".

-- 1. Extended center_membership columns
ALTER TABLE `center_membership` ADD COLUMN `end_date` DATE NULL,
    ADD COLUMN `membership_type` ENUM('research', 'clinical') NULL,
    ADD COLUMN `program_code` VARCHAR(16) NULL,
    ADD COLUMN `start_date` DATE NULL;

-- 2. Per-center program taxonomy
CREATE TABLE `center_program` (
    `center_code` VARCHAR(64) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`center_code`, `code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `center_membership_center_code_program_code_idx` ON `center_membership`(`center_code`, `program_code`);

ALTER TABLE `center_program` ADD CONSTRAINT `center_program_center_code_fkey` FOREIGN KEY (`center_code`) REFERENCES `center`(`code`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Membership -> program FK. NO ACTION (not the spec's SET NULL): the FK is
-- composite and `center_code` is NOT NULL, so SET NULL is invalid in MySQL.
-- Deleting a referenced program is blocked; a future program-delete feature must
-- clear members' program_code in-app first (with audit). (#552 §9 row 2 deviation.)
ALTER TABLE `center_membership` ADD CONSTRAINT `center_membership_center_code_program_code_fkey` FOREIGN KEY (`center_code`, `program_code`) REFERENCES `center_program`(`center_code`, `code`) ON DELETE NO ACTION ON UPDATE NO ACTION;
