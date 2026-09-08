-- Cores inference — NAME-ONLY known clients (core claim queue UI pass).
--
-- Widens `core_client` so a core owner can record someone who has no CWID: an
-- outside collaborator, a departed trainee, a vendor contact. Such a row is
-- roster-only. It can never flag a byline (the byline match is by CWID) and is
-- never mirrored to the engine (`lib/cores/client-writeback.ts` filters to
-- rows that have a cwid before it writes the CLIENTS item).
--
-- `cwid` goes NULLable. The existing UNIQUE (core_id, cwid) survives, but it
-- does NOT constrain the new rows: MySQL permits unlimited NULLs in a unique
-- index, so (core_id, NULL) never collides with itself. Duplicate name-only
-- rows are prevented in the route by a case-insensitive `display_name` check
-- against the core's active list. Do not "fix" this with a functional unique
-- index on COALESCE(cwid, display_name) — that would let a name-only "sab2028"
-- collide with the real CWID row.
--
-- No audit-log ENUM change: a name-only add reuses `core_client_add`, whose
-- target_entity_id carries the row id instead of the cwid (`{coreId}:#{id}`).
-- scripts/sql/audit-log.sql is untouched by this migration on purpose.

ALTER TABLE `core_client`
    MODIFY COLUMN `cwid` VARCHAR(32) NULL,
    ADD COLUMN `display_name` VARCHAR(255) NULL,
    ADD COLUMN `affiliation` VARCHAR(255) NULL;
