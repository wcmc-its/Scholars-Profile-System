-- #2519 PR 1 — Cornell (Ithaca) directory-member side table
-- (`docs/2026-08-26-cornell-ithaca-membership-SPEC.md` §3). Additive only: one
-- new table, no backfill, no change to `center_membership` / `division_membership`
-- (a Cornell member is an ordinary row there with `cwid = <netid>` and
-- `source = 'cornell-ithaca'`).
--
-- `cuid` is the Cornell NetID — see the model doc comment in schema.prisma for
-- the disjoint WCM-CWID / Cornell-NetID identity model this column relies on.

-- CreateTable
CREATE TABLE `external_member` (
    `cuid` VARCHAR(32) NOT NULL,
    `display_name` VARCHAR(255) NOT NULL,
    `given_name` VARCHAR(128) NULL,
    `family_name` VARCHAR(128) NULL,
    `title` VARCHAR(255) NULL,
    `dept` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `affiliation` VARCHAR(64) NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'cornell-ithaca',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cuid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
