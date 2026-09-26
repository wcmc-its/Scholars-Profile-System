-- =============================================================================
-- Retire report 10 (Display titles) — optional cleanup of its leftover rows
-- Context: report 10 moved out of /edit/reports to the Titles queue
--          (/edit/titles-queue), gated on superuser / comms_steward only.
-- Refs:    lib/edit/report-meta.ts (REPORT_KEYS) · lib/edit/report-access.ts
--          (REPORT_ACCESS_SCOPE_OPTIONS, isGrantableReportKey)
-- =============================================================================
--
-- NOT required for correctness. After the code change every leftover row is
-- inert:
--   * report_meta '10'            — loadReportMeta iterates REPORT_KEYS, not
--                                   the table, so the row is never read.
--   * report_access 'display-titles' — no page or route reads the key, the
--                                   grant route refuses it, hasAnyReportAccess
--                                   and the functional-roles import / parity
--                                   list skip it.
-- Cleaning up frees the 'display-titles' slug (report_meta.slug is UNIQUE)
-- and keeps the grant table honest.
--
-- These raw DELETEs write NO audit_log rows (the /edit grant route would, but
-- it no longer accepts this key). Run step 1 first and keep its output as the
-- record of what was removed. Run against each environment's app database;
-- it needs a write session, not a read-only probe.

-- 1. INSPECT -- what exists today. Save this output before step 2.
SELECT report_key, slug, name, updated_by, updated_at
FROM   report_meta
WHERE  report_key = '10';

SELECT report_key, scope_key, cwid, granted_by, granted_at
FROM   report_access
WHERE  report_key = 'display-titles'
ORDER BY cwid;

-- Functional-roles registry rows naming the retired scope (manual rows keep it
-- until edited; imported rows drop it on the next import). Review only — a
-- JSON edit is left to the /edit/administrators page.
SELECT role, cwid, source, scopes
FROM   functional_role_grant
WHERE  role = 'reporting'
  AND  JSON_CONTAINS(scopes, JSON_QUOTE('display-titles'));

-- 2. DELETE -- the leftover report 10 rows.
START TRANSACTION;
DELETE FROM report_access WHERE report_key = 'display-titles';
DELETE FROM report_meta   WHERE report_key = '10';
COMMIT;
