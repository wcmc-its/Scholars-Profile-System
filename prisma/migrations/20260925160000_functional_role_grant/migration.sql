-- Functional role assignments (/edit/administrators → Functional roles):
-- access not tied to an org unit. role = 'external_affairs' (one role; its
-- functions 'communications' / 'development' are the row's scopes) or
-- 'reporting' (scopes = '*', a report key, or 'reportKey:scope'). One row =
-- (role, cwid, source). source = 'manual' for an assignment made on the
-- Administrators page, or the mechanism an import mirrored ('report_access',
-- 'allowlist'); imported rows are read-only on the page. scopes is a JSON
-- string array. Gates read this table only while FUNCTIONAL_ROLES_AUTHZ is
-- 'on', and then only to ADD access (lib/auth/functional-role-authz.ts). Managed from
-- app/api/edit/functional-roles, audited as functional_role_grant /
-- functional_role_scope_set / functional_role_revoke. Additive; the table
-- starts empty (#584: migrations never INSERT) — the page's "Import from
-- sources" action seeds it.

CREATE TABLE `functional_role_grant` (
    `role` VARCHAR(32) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'manual',
    `scopes` JSON NOT NULL,
    `grantee_name` VARCHAR(255) NULL,
    `granted_by` VARCHAR(32) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `functional_role_grant_cwid_idx`(`cwid`),
    PRIMARY KEY (`role`, `cwid`, `source`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
