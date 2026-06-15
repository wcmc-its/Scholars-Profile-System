-- Org-unit outbound website URL (#1021).
--
-- An optional, curated link to the unit's own website, surfaced as a small
-- inline external-link arrow beside the unit NAME on each public page. Mirrors
-- `description`: nullable, edited via the dept/div `field_override(url)` row
-- (ED-preserving) and in-row for a center. Null everywhere until a curator sets
-- it, so the feature is dark-by-default with no flag — nothing renders until the
-- column carries a value.
ALTER TABLE `department` ADD COLUMN `url` VARCHAR(512) NULL;
ALTER TABLE `division` ADD COLUMN `url` VARCHAR(512) NULL;
ALTER TABLE `center` ADD COLUMN `url` VARCHAR(512) NULL;
