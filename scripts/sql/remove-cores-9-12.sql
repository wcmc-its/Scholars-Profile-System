-- =============================================================================
-- Remove cores 9 (Advanced Biomolecular Analysis) and 12 (Nuclear Magnetic
-- Resonance) and every row keyed on them
-- Context: the WCM cores director confirmed neither facility exists. Both were
--          dropped from CORE_CATALOG (etl/dynamodb/core-catalog.ts) and from
--          ReciterAI's config/core_dictionary.yaml. Their ids are retired and
--          never reused.
-- Refs:    etl/dynamodb/index.ts Block 6 · prisma/schema.prisma (Core and the
--          core_* models, UnitAdmin, OrgUnitRoleAssignment, OrgUnitRoleScope,
--          FieldOverride, Suppression)
-- =============================================================================
--
-- REQUIRED, not cosmetic. The nightly ETL upserts the catalog but never
-- deletes a `core` row, and it builds the publication_core FK guard from the
-- rows IN THE TABLE (`knownCoreIds = core.findMany()`), not from CORE_CATALOG.
-- So while these two rows exist, any CORE#9 / CORE#12 item the engine still
-- emits keeps projecting, and the #2601 publication_core prune HOLDS BACK
-- (never deletes) a core with zero writes in a run, so their existing usage
-- rows would sit there forever. Once the `core` rows are gone, the guard drops
-- every engine row for these ids (`skippedMissingCore`) and nothing re-creates
-- them: CORE_CATALOG is the only writer of `core` rows.
--
-- Idempotent: every statement is a keyed DELETE, so a second run deletes
-- nothing. core_leader and publication_core also cascade from `core`; they are
-- deleted explicitly anyway so step 1's counts match what step 2 removes.
-- core_claim / core_queue_add / core_client and the polymorphic entity_type
-- tables have NO FK to `core`, so they would NOT cascade.
--
-- NOT touched: audit_log (immutable, hash-chained history; the rows stay as the
-- record of what happened). These raw DELETEs write NO audit_log rows. Run
-- step 1 first and keep its output as the record of what was removed.
--
-- Also NOT touched by SQL: the ReciterAI DynamoDB mirror of core_client and
-- core_claim (lib/cores/client-writeback.ts, lib/cores/claim-writeback.ts).
-- Any mirrored items for cores 9/12 are inert once the dictionary entries are
-- gone upstream.
--
-- Run against each environment's app database; it needs a write session, not
-- a read-only probe.

-- 1. INSPECT -- what exists today. Save this output before step 2.
SELECT 'core'                     AS tbl, COUNT(*) AS n FROM core                     WHERE id      IN ('9','12')
UNION ALL SELECT 'core_leader',              COUNT(*) FROM core_leader              WHERE core_id IN ('9','12')
UNION ALL SELECT 'publication_core',         COUNT(*) FROM publication_core         WHERE core_id IN ('9','12')
UNION ALL SELECT 'core_claim',               COUNT(*) FROM core_claim               WHERE core_id IN ('9','12')
UNION ALL SELECT 'core_queue_add',           COUNT(*) FROM core_queue_add           WHERE core_id IN ('9','12')
UNION ALL SELECT 'core_client',              COUNT(*) FROM core_client              WHERE core_id IN ('9','12')
UNION ALL SELECT 'unit_admin',               COUNT(*) FROM unit_admin               WHERE entity_type = 'core' AND entity_id IN ('9','12')
UNION ALL SELECT 'org_unit_role_assignment', COUNT(*) FROM org_unit_role_assignment WHERE entity_type = 'core' AND entity_id IN ('9','12')
UNION ALL SELECT 'org_unit_role_scope',      COUNT(*) FROM org_unit_role_scope      WHERE entity_type = 'core' AND entity_id IN ('9','12')
UNION ALL SELECT 'field_override',           COUNT(*) FROM field_override           WHERE entity_type = 'core' AND entity_id IN ('9','12')
UNION ALL SELECT 'suppression',              COUNT(*) FROM suppression              WHERE entity_type = 'core' AND entity_id IN ('9','12');

SELECT id, name, facility, visible, refreshed_at FROM core WHERE id IN ('9','12');

-- 2. DELETE -- children first, then the catalog rows.
START TRANSACTION;
DELETE FROM core_leader              WHERE core_id IN ('9','12');
DELETE FROM publication_core         WHERE core_id IN ('9','12');
DELETE FROM core_claim               WHERE core_id IN ('9','12');
DELETE FROM core_queue_add           WHERE core_id IN ('9','12');
DELETE FROM core_client              WHERE core_id IN ('9','12');
DELETE FROM unit_admin               WHERE entity_type = 'core' AND entity_id IN ('9','12');
DELETE FROM org_unit_role_assignment WHERE entity_type = 'core' AND entity_id IN ('9','12');
DELETE FROM org_unit_role_scope      WHERE entity_type = 'core' AND entity_id IN ('9','12');
DELETE FROM field_override           WHERE entity_type = 'core' AND entity_id IN ('9','12');
DELETE FROM suppression              WHERE entity_type = 'core' AND entity_id IN ('9','12');
DELETE FROM core                     WHERE id      IN ('9','12');
COMMIT;

-- 3. VERIFY -- re-run step 1; every count must be 0.
