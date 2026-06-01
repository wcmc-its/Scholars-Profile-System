-- =============================================================================
-- B03 — Append-only manual-edit audit log
-- Issues: #102 (B03 audit log) · #354 (generalized row shape)
-- Refs:   docs/b03-audit-log.md · docs/ADR-005-manual-override-layer.md
--         docs/self-edit-spec.md · docs/PRODUCTION_ADDENDUM.md (section /api/edit)
-- =============================================================================
--
-- Every successful /api/edit write -- a field override, a suppression create,
-- or a suppression revoke -- appends exactly one row to this table, inside the
-- same MySQL transaction as the manual-layer write it audits.
--
-- WHY A SEPARATE DATABASE
--   The table lives in its own database (`scholars_audit`), separate from the
--   application database, on the SAME MySQL server / Aurora cluster.
--     - Same server      -> one transaction can span the application database
--                           and `scholars_audit`, so the manual-layer row and
--                           its audit row commit atomically (ADR-005 section
--                           Write-path failure model).
--     - Separate database -> the application role can be granted INSERT and
--                           nothing else here, while keeping full DML on the
--                           application database. That asymmetric grant is what
--                           makes the log append-only and tamper-evident.
--
--   The table is deliberately NOT a Prisma model and NOT in prisma/schema.prisma.
--   Keeping it out of the ORM means UPDATE / DELETE against an audit row are not
--   expressible in application code at all. The write path inserts via
--   `tx.$executeRaw` against the fully-qualified name. See docs/b03-audit-log.md.
--
-- APPLY  (run against the SAME server as the application database, using a
--         privileged account -- the application role cannot CREATE DATABASE):
--
--     mysql -h <host> -u <admin> -p < scripts/sql/audit-log.sql
--
--   then apply the GRANT at the foot of this file, substituting the real
--   application user. Idempotent (IF NOT EXISTS throughout) -- re-running is
--   safe.
--
--   CODIFIED PATH (#493). The executable DDL in this file is the single source
--   of truth for `scripts/db-bootstrap.ts`, run on every deploy as the one-shot
--   `sps-db-bootstrap-${env}` Fargate task BEFORE `sps-migrate`. That task
--   applies this DDL and the INSERT grant automatically -- as the least-
--   privilege `sps_bootstrap` user, never master -- and fails the deploy if the
--   grant does not verify INSERT-only. The runner strips comments and runs the
--   remaining statements, so the commented GRANT template below never executes;
--   it computes the real grantee from the live app-rw DSN instead.
--
--   This file is still not a Prisma migration and is not run by
--   `prisma migrate deploy`. Local dev: `npm run db:audit-setup`.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `scholars_audit`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `scholars_audit`.`manual_edit_audit` (
  -- Monotonic surrogate key, DB-assigned. A gap in the sequence is itself
  -- tamper-evidence (a removed row leaves a hole). Not covered by `row_hash`,
  -- which the write path computes BEFORE the row exists and the id is assigned.
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- WHO -- the signed-in actor's CWID (the B01 SSO session subject). ALWAYS the
  -- real human, even under impersonation (#637 R3 -- never the impersonated CWID).
  `actor_cwid`         VARCHAR(32)  NOT NULL,

  -- ON BEHALF OF WHOM -- the target CWID a write happened on behalf of while the
  -- actor was impersonating ("View as", #637 section 3 / R3), else NULL. The
  -- non-repudiable actor stays `actor_cwid`; this records the impersonated
  -- subject so an edit reads "actor, acting as target." NULL for every ordinary
  -- (non-impersonated) write, including all rows that predate #637. Part of the
  -- `row_hash` recipe v2 (the last positional element). VARCHAR(32) mirrors
  -- `actor_cwid`; positioned beside it so the two attribution columns sit together.
  `impersonated_cwid`  VARCHAR(32)  NULL,

  -- WHAT -- the target. #354 generalizes #102's single `scholar_cwid` to a
  -- (type, id) pair so a row can audit a publication or (publication, author)
  -- target, not only a scholar. #540 Phase 1 extends the type set to org
  -- units (department/division/center) for unit curation. `target_entity_id`
  -- is scholar.cwid for a scholar target, publication.pmid for a publication
  -- target, and the unit `code` for a department/division/center target; a
  -- per-author publication suppression carries the contributor CWID in the
  -- JSON payload.
  `target_entity_type` ENUM('scholar','publication','grant','education','appointment','department','division','center') NOT NULL,
  `target_entity_id`   VARCHAR(64)  NOT NULL,

  -- WHICH -- the action discriminator (#354). `field_override` is a scalar-field
  -- edit; `field_override_clear` is a delete of one `field_override` row
  -- (#356 Phase 7 -- the slug-card "Clear override" action); `suppression_create`
  -- / `suppression_revoke` are suppression events; `request_change` is a
  -- "Request a change" email routed to the owning office (#160 Phase 2 -- a
  -- best-effort row written AFTER the send, so a missing INSERT grant degrades
  -- to a logged audit gap, never a lost email). #540 Phase 1 adds three
  -- unit-curation actions: `unit_create` (a manually-owned center or a
  -- manually-created division, including informal no-code subunits);
  -- `roster_change` (add/remove a CenterMembership / DivisionMembership row);
  -- `grant_change` (a UnitAdmin INSERT or hard-DELETE). #637 adds two "View as"
  -- session events: `impersonation_start` / `impersonation_end` (R5 -- audit
  -- enter AND exit; `target_entity_type='scholar'`, `target_entity_id` the
  -- impersonated CWID).
  `action`             ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end') NOT NULL,

  -- THE CHANGE.
  --   fields_changed -- JSON array of field names for a `field_override`
  --                     (e.g. ["overview"]); NULL for a suppression event.
  --   before_values  -- JSON. Field override: the pre-/post-edit value(s).
  --   after_values      Suppression event: the reason / contributor_cwid /
  --                     revoked_by / revoked_at payload (#354).
  `fields_changed`     JSON         NULL,
  `before_values`      JSON         NULL,
  `after_values`       JSON         NULL,

  -- Row-level tamper-evidence (#102): a SHA-256 hex digest the write path
  -- computes over the row's canonical content. Not a substitute for the values,
  -- and not a hash chain -- it detects mutation of a single row. The exact
  -- recipe (field order, serialization) is in docs/b03-audit-log.md so any
  -- reviewer can recompute and verify it.
  `row_hash`           CHAR(64)     NOT NULL,

  -- WHEN -- set by the write path, not the DB: the value is an input to
  -- `row_hash`, so it must be known before the INSERT. No column DEFAULT -- a
  -- missing `ts` is an error, never a silently-substituted server clock.
  `ts`                 DATETIME(3)  NOT NULL,

  -- Correlation id -- ties the audit row to one request and its log lines
  -- (the `edit_authz_denied` / `self_suppression` events). NULL-tolerant.
  `request_id`         VARCHAR(64)  NULL,

  PRIMARY KEY (`id`),

  -- Supports the #102 spot-check: "every change to scholar X by actor Y in
  -- date range Z" -- target lookup first, then actor, both date-bounded.
  KEY `idx_target` (`target_entity_type`, `target_entity_id`, `ts`),
  KEY `idx_actor`  (`actor_cwid`, `ts`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- IDEMPOTENT ENUM EXTENSIONS for existing deploys.
--
-- `CREATE TABLE IF NOT EXISTS` above does not modify an existing table, so
-- when the `action` ENUM grows we must `MODIFY COLUMN` to extend it on
-- already-installed deployments. The statement is idempotent: MySQL accepts
-- `MODIFY COLUMN ... ENUM(...)` with an enum set that already matches as a
-- no-op (no data conversion, no row touched). The full enum is restated each
-- time so this block always reflects the canonical column definition.
--
-- Action history:
--   Phase 1 (#102/#354): field_override · suppression_create · suppression_revoke
--   Phase 7 (#356):    + field_override_clear  (slug-card "Clear override")
--   #160 Phase 2:      + request_change        ("Request a change" server mailer)
--   #497 PR-3:         + slug_request · slug_request_approved · slug_request_rejected
--                        · slug_request_withdrawn  (slug-request queue)
--   #540 Phase 1:      + unit_create · roster_change · grant_change
--                        (org-unit curation; also extends target_entity_type
--                         with department / division / center -- the second
--                         MODIFY COLUMN below)
--   #637:              + impersonation_start · impersonation_end
--                        (View-as impersonation; also adds the
--                         `impersonated_cwid` attribution column -- the
--                         ADD COLUMN below)
-- =============================================================================

ALTER TABLE `scholars_audit`.`manual_edit_audit`
  MODIFY COLUMN `action`
    ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end')
    NOT NULL;

-- target_entity_type history:
--   #102/#354: scholar · publication · grant · education · appointment
--   #540 Phase 1: + department · division · center
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  MODIFY COLUMN `target_entity_type`
    ENUM('scholar','publication','grant','education','appointment','department','division','center')
    NOT NULL;

-- #637 (View-as impersonation): the `impersonated_cwid` attribution column for
-- already-installed deploys. `CREATE TABLE IF NOT EXISTS` above carries it for
-- fresh installs; `ADD COLUMN IF NOT EXISTS` is a no-op once present (mirrors
-- the idempotent ENUM MODIFYs above). A table-level INSERT grant covers a new
-- column automatically -- no grant change (confirm INSERT-only post-apply).
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  ADD COLUMN IF NOT EXISTS `impersonated_cwid` VARCHAR(32) NULL AFTER `actor_cwid`;

-- =============================================================================
-- GRANT -- append-only for the application role.
--
-- ENVIRONMENT-SPECIFIC, so this is a template, not executed by the script: the
-- user name and host differ per environment, and the role is provisioned by a
-- DBA (staging / prod) or the developer (local). Apply it after the table
-- exists.
--
--   GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO '<app_user>'@'<host>';
--   -- and explicitly NOTHING else: no UPDATE, no DELETE, no DROP, no ALTER.
--
-- Verify the grant is INSERT-only (#102 acceptance criterion):
--
--   SHOW GRANTS FOR '<app_user>'@'<host>';
--
-- RETENTION purging needs DELETE and MUST run under a SEPARATE privileged role
-- -- never the application role. See docs/b03-audit-log.md (section Retention).
-- =============================================================================
