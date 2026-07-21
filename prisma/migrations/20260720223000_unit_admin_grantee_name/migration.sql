-- AlterTable: capture the grantee display name at pull time (ed-admins ETL), so the
-- Administrators roster resolves NON-Scholar admins without a live LDAP lookup (#443).
ALTER TABLE `unit_admin` ADD COLUMN `grantee_name` VARCHAR(255) NULL;
