-- =============================================================================
-- "View as" impersonation -- audit migration (#637 section 10)
-- Issues: #637 (View-as impersonation) · #102/#354 (B03 audit log)
-- Refs:   docs/b03-audit-log.md · docs/impersonation-spec.md
--         scripts/sql/audit-log.sql · tmp/impersonation-spec.md section 10
-- =============================================================================
--
-- DO NOT AUTO-RUN. This is a REVIEW artifact, not an executed migration. It
-- documents exactly what must change on `scholars_audit.manual_edit_audit` so
-- the security review can approve the B03 hash bump (recipe v1 -> v2) before
-- anything touches a database. It follows the SAME deploy path as #493's grant
-- work: the canonical DDL lives in `scripts/sql/audit-log.sql`, which
-- `scripts/db-bootstrap.ts` applies on every deploy as the one-shot
-- `sps-db-bootstrap-${env}` Fargate task (least-privilege `sps_bootstrap`, never
-- master) BEFORE `sps-migrate`. On sign-off, fold the two ALTERs below into
-- `scripts/sql/audit-log.sql` (restating the canonical column definitions, as
-- that file already does for every prior ENUM extension) rather than running
-- this file directly. It is kept here as the standalone, reviewable delta.
--
-- Idempotent: MySQL accepts a `MODIFY COLUMN ... ENUM(...)` whose enum set
-- already matches as a no-op, and `ADD COLUMN IF NOT EXISTS` is a no-op once the
-- column exists. Re-running is safe.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ENUM extension -- two new impersonation actions (#637 R5: audit enter AND
--    exit). The full enum is restated (every current value + the two new ones,
--    derived from the `AuditAction` union in lib/edit/audit.ts):
--      field_override · field_override_clear · suppression_create
--      · suppression_revoke · request_change · slug_request
--      · slug_request_approved · slug_request_rejected · slug_request_withdrawn
--      · unit_create · roster_change · grant_change
--      + impersonation_start · impersonation_end          (#637)
-- -----------------------------------------------------------------------------
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  MODIFY COLUMN `action`
    ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end')
    NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. New column -- `impersonated_cwid`: the target CWID a write happened on
--    behalf of while the actor was impersonating, else NULL (#637 section 3 /
--    R3). `actor_cwid` stays the real human; this column records "on behalf of
--    whom." NULL for every ordinary (non-impersonated) write, including all
--    rows that predate this migration. VARCHAR(32) mirrors `actor_cwid`.
--    Positioned AFTER `actor_cwid` so the two attribution columns sit together.
-- -----------------------------------------------------------------------------
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  ADD COLUMN IF NOT EXISTS `impersonated_cwid` VARCHAR(32) NULL AFTER `actor_cwid`;

-- -----------------------------------------------------------------------------
-- 3. row_hash recipe v1 -> v2 (no DDL -- application change, here for the record).
--    `lib/edit/audit.ts::computeRowHash` now appends `impersonated_cwid` as the
--    LAST positional element (10 elements, was 9). Rows written BEFORE this
--    migration verify under recipe v1 (9 elements); rows AFTER, under v2 -- a
--    verifier picks the recipe by `ts` relative to the migration timestamp.
--    This is the ONLY change that touches the security-reviewed B03 hash.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- GRANT REMINDER (cf. #493 `sps_bootstrap`).
--    No grant change is required: the least-privilege application role already
--    holds `INSERT ON scholars_audit.manual_edit_audit` and nothing else, and a
--    table-level INSERT grant covers a newly-added column automatically. CONFIRM
--    after applying that `SHOW GRANTS FOR '<app_user>'@'<host>'` still reports
--    INSERT-only on this table (the #102 acceptance criterion the bootstrap task
--    verifies) -- and that the bootstrap task still passes its INSERT-only check.
-- -----------------------------------------------------------------------------
