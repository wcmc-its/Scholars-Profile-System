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
  `target_entity_type` ENUM('scholar','publication','grant','education','appointment','department','division','center','mentee','coi_gap_candidate','method_family','core','reporter_profile_candidate','opportunity_submission','profile_appointment','honor','news_mention') NOT NULL,
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
  -- impersonated CWID). The comms-steward Method-Family surface adds two:
  -- `family_tier_set` (a steward set a family's tier via the overlay) and
  -- `family_review` (a steward cleared the review nag without changing tier);
  -- both carry `target_entity_type='method_family'`, `target_entity_id` the
  -- `supercategory:family_label` pair. The opportunity URL intake
  -- (`OPPORTUNITY_URL_INTAKE`, docs/opportunity-url-intake-spec.md) adds
  -- `opportunity_submission` (a dev-role member queued a funding-opportunity
  -- URL for the ReciterAI pipeline; `target_entity_type=
  -- 'opportunity_submission'`, `target_entity_id` the queue item's sort key)
  -- -- appended LAST to both ENUMs; migration:
  -- scripts/sql/opportunity-submission-audit-migration.sql. #1323 then adds
  -- `appointment_visibility_set` (a curator / comms_steward set a historical
  -- `ED-HISTORICAL` appointment's public visibility; `target_entity_type=
  -- 'appointment'`, `target_entity_id` the appointment `external_id`) --
  -- appended LAST after `opportunity_submission`. #1568 then adds
  -- `profile_appointment_create` / `profile_appointment_update` /
  -- `profile_appointment_delete` (a scholar / curator added / edited / removed a
  -- self-asserted `profile_appointment` row on /edit; `target_entity_type=
  -- 'profile_appointment'`, `target_entity_id` the row `id`) -- appended LAST
  -- after `appointment_visibility_set`. The intake Submissions sub-tab then
  -- adds `opportunity_submission_delete` / `opportunity_submission_suppress`
  -- (a dev-role member deleted a pending/rejected submission or suppressed a
  -- processed one; same target type/id as `opportunity_submission`) --
  -- appended LAST after `profile_appointment_delete`. #1760 then adds
  -- `honor_create` / `honor_update` / `honor_delete` (a scholar / curator
  -- added / edited / removed an Honors & Distinctions row on /edit;
  -- `target_entity_type='honor'`, `target_entity_id` the row `id`) --
  -- appended LAST after `opportunity_submission_suppress`.
  `action`             ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end','publication_reject','coi_gap_dismiss','coi_gap_restore','proxy_grant','proxy_revoke','family_tier_set','family_review','coi_gap_feedback','core_claim','reporter_profile_confirm','reporter_profile_reject','reporter_profile_revoke','opportunity_submission','appointment_visibility_set','profile_appointment_create','profile_appointment_update','profile_appointment_delete','opportunity_submission_delete','opportunity_submission_suppress','honor_create','honor_update','honor_delete','news_mention_update') NOT NULL,

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
--   #746:              + publication_reject  (self-edit "Not mine" reject routed
--                         to ReCiter's gold standard; target_entity_id is the
--                         pmid, target_entity_type='publication'). Appended LAST
--                         to preserve existing ENUM ordinals.
--   SELF_EDIT_COI_GAP_HINT: + coi_gap_dismiss  (scholar dismissed a
--                         publication-derived COI-gap candidate on the self-only
--                         "From your publications" panel; target_entity_id is the
--                         `coi_gap_candidate.id`, target_entity_type=
--                         'coi_gap_candidate'). Appended LAST to preserve
--                         existing ENUM ordinals.
--   #779:              + proxy_grant · proxy_revoke  (scholar-assigned proxy
--                         editor grant/revoke; scholar-proxy-spec.md / ADR-005
--                         Amendment 3; target_entity_type='scholar',
--                         target_entity_id is the granted scholar cwid). Appended
--                         LAST to preserve existing ENUM ordinals.
--   COMMS_STEWARD_ENABLED: + family_tier_set · family_review  (comms-steward
--                         Method-Family surface; docs/comms-steward-methods-
--                         visibility-spec.md §5/§7; target_entity_type=
--                         'method_family', target_entity_id is the
--                         `supercategory:family_label` pair). Appended LAST to
--                         preserve existing ENUM ordinals.
--   SELF_EDIT_COI_GAP_HINT (feedback): + coi_gap_feedback  (scholar's 3-way
--                         response on a COI-gap suggestion -- will_disclose |
--                         historical | invalid; supersedes coi_gap_dismiss, which
--                         is retained for ordinals + back-compat. target_entity_
--                         type='coi_gap_candidate', target_entity_id is the
--                         candidate id). Appended LAST to preserve existing ENUM
--                         ordinals.
--   CORE_CLAIM (cores inference): + core_claim  (a core owner claimed/rejected a
--                         (publication, core) usage candidate; target_entity_type=
--                         'core', target_entity_id is the "{coreId}:{pmid}" pair).
--                         Appended LAST to preserve existing ENUM ordinals.
--   REPORTER_MATCH_V2: + reporter_profile_confirm | reporter_profile_reject |
--                         reporter_profile_revoke  (a RePORTER PMID-overlap "Is
--                         this you?" match confirmed / declined / revoked;
--                         target_entity_type='reporter_profile_candidate',
--                         target_entity_id is the candidate id). Appended LAST to
--                         preserve existing ENUM ordinals.
--   OPPORTUNITY_URL_INTAKE: + opportunity_submission  (a development-role member
--                         queued a funding-opportunity URL for the ReciterAI
--                         pipeline; docs/opportunity-url-intake-spec.md;
--                         target_entity_type='opportunity_submission',
--                         target_entity_id is the queue item's sort key).
--                         Appended LAST to preserve existing ENUM ordinals.
-- =============================================================================

--   #1323 (cont.): + appointment_visibility_set  (a curator / comms_steward
--                         revealed / re-hid a historical ED-HISTORICAL
--                         appointment; target_entity_type='appointment',
--                         target_entity_id the appointment external_id). Appended
--                         LAST to preserve existing ENUM ordinals.
--   #1568:             + profile_appointment_create · profile_appointment_update
--                         · profile_appointment_delete  (a scholar / curator
--                         added / edited / removed a self-asserted
--                         `profile_appointment` row on /edit; target_entity_type=
--                         'profile_appointment', target_entity_id the row id).
--                         Appended LAST to preserve existing ENUM ordinals.
--   OPPORTUNITY_URL_INTAKE (Submissions sub-tab): + opportunity_submission_delete
--                         · opportunity_submission_suppress  (a dev-role member
--                         deleted an unconsumed pending/rejected submission, or
--                         suppressed a processed one so ReciterAI's drain
--                         companion retracts its produced GRANT# items;
--                         target_entity_type='opportunity_submission',
--                         target_entity_id the queue item's sort key). Appended
--                         LAST to preserve existing ENUM ordinals.
--   #1760:             + honor_create · honor_update · honor_delete  (a scholar
--                         / curator added / edited / removed an Honors &
--                         Distinctions row on /edit; target_entity_type='honor',
--                         target_entity_id the `honor.id`).
--                         Appended LAST to preserve existing ENUM ordinals.
--   News mentions (docs/2026-07-18-news-mentions-plan.md): + news_mention_update
--                         (a scholar / curator / comms_steward changed a news
--                         mention's review status or profile visibility on /edit
--                         -- approve/reject in /edit/news-queue, or hide / "not
--                         me" on the owning profile; target_entity_type=
--                         'news_mention', target_entity_id the `news_mention.id`.
--                         The etl/news ingest writes directly and is NOT audited).
--                         Appended LAST to preserve existing ENUM ordinals.
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  MODIFY COLUMN `action`
    ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end','publication_reject','coi_gap_dismiss','coi_gap_restore','proxy_grant','proxy_revoke','family_tier_set','family_review','coi_gap_feedback','core_claim','reporter_profile_confirm','reporter_profile_reject','reporter_profile_revoke','opportunity_submission','appointment_visibility_set','profile_appointment_create','profile_appointment_update','profile_appointment_delete','opportunity_submission_delete','opportunity_submission_suppress','honor_create','honor_update','honor_delete','news_mention_update')
    NOT NULL;

-- target_entity_type history:
--   #102/#354: scholar · publication · grant · education · appointment
--   #540 Phase 1: + department · division · center
--   #160 follow-up: + mentee  (derived mentor↔mentee relationship hide;
--                    target_entity_id is `{mentorCwid}:{menteeCwid}`)
--   SELF_EDIT_COI_GAP_HINT: + coi_gap_candidate  (dismissed publication-derived
--                    COI-gap candidate; target_entity_id is the candidate id).
--                    Appended LAST to preserve existing ENUM ordinals.
--   COMMS_STEWARD_ENABLED: + method_family  (comms-steward Method-Family tier /
--                    review actions; target_entity_id is the
--                    `supercategory:family_label` pair). Appended LAST to
--                    preserve existing ENUM ordinals.
--   CORE_CLAIM (cores inference): + core  (a (publication, core) usage claim /
--                    rejection; target_entity_id is the "{coreId}:{pmid}" pair).
--                    Appended LAST to preserve existing ENUM ordinals.
--   REPORTER_MATCH_V2: + reporter_profile_candidate  (a RePORTER PMID-overlap
--                    match confirmed / rejected / revoked in /edit;
--                    target_entity_id is the candidate id). Appended LAST to
--                    preserve existing ENUM ordinals.
--   OPPORTUNITY_URL_INTAKE: + opportunity_submission  (a funding-opportunity URL
--                    submission queue item in the shared reciterai DynamoDB
--                    table; target_entity_id is the item's time-ordered sort
--                    key). Appended LAST to preserve existing ENUM ordinals.
--   #1568:          + profile_appointment  (a self-asserted profile appointment
--                    edited on /edit; target_entity_id is the
--                    `profile_appointment.id`). Appended LAST to preserve
--                    existing ENUM ordinals.
--   #1760:          + honor  (an Honors & Distinctions row curated on /edit;
--                    target_entity_id is the `honor.id`). Appended LAST to
--                    preserve existing ENUM ordinals.
--   News mentions (docs/2026-07-18-news-mentions-plan.md): + news_mention  (a news
--                    mention curated on /edit; target_entity_id is the
--                    `news_mention.id`). Appended LAST to preserve existing ENUM
--                    ordinals.
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  MODIFY COLUMN `target_entity_type`
    ENUM('scholar','publication','grant','education','appointment','department','division','center','mentee','coi_gap_candidate','method_family','core','reporter_profile_candidate','opportunity_submission','profile_appointment','honor','news_mention')
    NOT NULL;

-- #637 (View-as impersonation): the `impersonated_cwid` attribution column for
-- already-installed deploys. `CREATE TABLE IF NOT EXISTS` above carries it for
-- fresh installs. Aurora (MySQL 8.0) has NO `ADD COLUMN IF NOT EXISTS` (that is
-- MariaDB-only), so this is a plain `ADD COLUMN`; idempotency is provided by the
-- bootstrap runner (`scripts/db-bootstrap.ts`), which treats the re-run
-- duplicate-column error (1060 / ER_DUP_FIELDNAME) on an ADD COLUMN as a no-op.
-- A table-level INSERT grant covers a new column automatically -- no grant
-- change (confirm INSERT-only post-apply).
ALTER TABLE `scholars_audit`.`manual_edit_audit`
  ADD COLUMN `impersonated_cwid` VARCHAR(32) NULL AFTER `actor_cwid`;

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
-- READER (#917). The /edit history pages read this table through the read-only `app_ro` role,
-- which therefore needs SELECT here (it has none otherwise -- least-privilege; the writer has
-- INSERT only). That grant is NOT run by this script: it is issued by the master seeder custom
-- resource (`cdk/lambda/db-bootstrap-seed` runAppRoAuditGrant), which discovers app_ro's real
-- host. The equivalent manual statement, for reference, is:
--
--   GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'<host>';
--   -- SELECT-only: never INSERT/UPDATE/DELETE on the append-only log.
--
-- ROLLOUT ORDER (#917 — same paired-edit coupling as ADR-009 Phase 3). The verify-grants golden
-- (scripts/verify-db-grants.ts ROLES['app-ro']) now REQUIRES this SELECT, and verify-grants runs
-- fails-closed in the deploy.yml image-roll pipeline. So per env, run `cdk deploy Sps-Data-<env>`
-- (fires the Revision-bumped seeder → this grant lands) BEFORE the image-roll deploy that carries
-- the updated golden — otherwise verify-grants reports MISSING and the service is NOT rolled
-- (recoverable: deploy DataStack, then re-run). Staging deploy.yml auto-runs on push-to-master.
--
-- Verify the grant is INSERT-only (#102 acceptance criterion):
--
--   SHOW GRANTS FOR '<app_user>'@'<host>';
--
-- RETENTION purging needs DELETE and MUST run under a SEPARATE privileged role
-- -- never the application role. See docs/b03-audit-log.md (section Retention).
-- =============================================================================
