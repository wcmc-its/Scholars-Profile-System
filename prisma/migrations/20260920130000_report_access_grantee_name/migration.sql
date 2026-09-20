-- Per-report access grants (report_access): capture the grantee's name.

-- AlterTable
-- The grantee's directory display name as the "Who can run this report"
-- popover's people picker returned it AT GRANT TIME. The app runtime cannot
-- reach LDAP (#443), so a name resolved on the fly at render would fall back
-- to the bare CWID for any grantee without a Scholar row — the Medical
-- Education staff this table exists for. Same shape and rationale as
-- unit_admin.grantee_name. Read back as
-- Scholar.preferredName ?? grantee_name ?? cwid. Additive + nullable: rows
-- granted before this column stay NULL and show the CWID until re-granted.
ALTER TABLE `report_access` ADD COLUMN `grantee_name` VARCHAR(255) NULL;
