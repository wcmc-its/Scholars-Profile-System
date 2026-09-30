-- Institution administrators: an owner/curator of unit_admin(institution, <ED
-- primary-organization code>) proxy-edits every scholar whose primary
-- appointment carries that code (lib/edit/unit-scholar-authz.ts). Additive.

-- AlterTable
-- ED weillCornellEduPrimaryOrganization (WCMC, WCMC-Q, HMC, SIDRA, HSS, ...).
-- NULL until the next ED ETL run writes it.
ALTER TABLE `scholar` ADD COLUMN `primary_org_code` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `scholar_primary_org_code_idx` ON `scholar`(`primary_org_code`);

-- AlterTable
-- `institution` appended to the EntityType enum on every column that carries
-- it. Appending keeps existing values' ordinal positions.
ALTER TABLE `unit_admin` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit', 'institution') NOT NULL;

-- AlterTable
ALTER TABLE `field_override` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit', 'institution') NOT NULL;

-- AlterTable
ALTER TABLE `suppression` MODIFY `entity_type` ENUM('scholar', 'publication', 'grant', 'education', 'appointment', 'department', 'division', 'center', 'mentee', 'core', 'dataset_deposit', 'institution') NOT NULL;
