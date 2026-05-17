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
--   safe. Local dev: the MariaDB instance the app uses. Staging / prod: the
--   Aurora cluster, applied by a DBA -- or folded into the B09 (#108) migration
--   pipeline once it lands. This file is not a Prisma migration and is not run
--   by `prisma migrate deploy`.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `scholars_audit`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `scholars_audit`.`manual_edit_audit` (
  -- Monotonic surrogate key, DB-assigned. A gap in the sequence is itself
  -- tamper-evidence (a removed row leaves a hole). Not covered by `row_hash`,
  -- which the write path computes BEFORE the row exists and the id is assigned.
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- WHO -- the signed-in actor's CWID (the B01 SSO session subject).
  `actor_cwid`         VARCHAR(32)  NOT NULL,

  -- WHAT -- the target. #354 generalizes #102's single `scholar_cwid` to a
  -- (type, id) pair so a row can audit a publication or (publication, author)
  -- target, not only a scholar. `target_entity_id` is scholar.cwid for a
  -- scholar target, publication.pmid for a publication target; a per-author
  -- publication suppression carries the contributor CWID in the JSON payload.
  `target_entity_type` ENUM('scholar','publication','grant','education','appointment') NOT NULL,
  `target_entity_id`   VARCHAR(64)  NOT NULL,

  -- WHICH -- the action discriminator (#354). `field_override` is a scalar-field
  -- edit; `suppression_create` / `suppression_revoke` are suppression events.
  `action`             ENUM('field_override','suppression_create','suppression_revoke') NOT NULL,

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
