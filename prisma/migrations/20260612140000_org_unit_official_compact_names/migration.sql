-- Org-unit official + compact display names (docs/org-unit-curation-spec.md).
--
-- Curated, ED-preserving: the ED ETL writes only `name`/`slug` on UPDATE, never
-- these two columns, so a curated rename (e.g. ED `name` "Library" -> official
-- "Samuel J. Wood Library") survives every refresh. Both nullable; the display
-- layer coalesces officialName ?? name (full surfaces) and compactName ?? name
-- (facet chips). Centers carry both for symmetry; a center's `name` already
-- serves as its official name (no ETL fights it), so center.official_name stays
-- NULL and the compact_name carries the short facet label.
ALTER TABLE `department` ADD COLUMN `official_name` VARCHAR(255) NULL;
ALTER TABLE `department` ADD COLUMN `compact_name` VARCHAR(255) NULL;
ALTER TABLE `center` ADD COLUMN `official_name` VARCHAR(255) NULL;
ALTER TABLE `center` ADD COLUMN `compact_name` VARCHAR(255) NULL;
