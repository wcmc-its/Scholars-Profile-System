-- Opportunity URL intake (docs/opportunity-url-intake-spec.md) -- extend the
-- B03 audit ENUMs with the `opportunity_submission` action + entity type.
--
-- NORMALLY YOU DO NOT RUN THIS BY HAND. The codified path (#493) applies it:
-- the trailing idempotent `MODIFY COLUMN` blocks in audit-log.sql carry these
-- exact widenings, and the one-shot `sps-db-bootstrap-<env>` Fargate task
-- replays that file (as `sps_bootstrap`, which holds ALTER on scholars_audit.*)
-- in the deploy pipeline BEFORE `sps-migrate` -- so any staging/prod deploy at
-- or after this commit has already widened the ENUMs. Kept only as a manual
-- fallback for a DB that cannot take a deploy; the `etl` and app users cannot
-- run it (no ALTER on scholars_audit -- verified 2026-07-06, error 1142).
-- Appending values to the END of a MySQL ENUM is an in-place metadata change
-- (no table rebuild); appending (never reordering) keeps stored ordinals
-- stable. Canonical DDL: audit-log.sql.

ALTER TABLE scholars_audit.manual_edit_audit
  MODIFY COLUMN `target_entity_type` ENUM('scholar','publication','grant','education','appointment','department','division','center','mentee','coi_gap_candidate','method_family','core','reporter_profile_candidate','opportunity_submission') NOT NULL;

ALTER TABLE scholars_audit.manual_edit_audit
  MODIFY COLUMN `action` ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end','publication_reject','coi_gap_dismiss','coi_gap_restore','proxy_grant','proxy_revoke','family_tier_set','family_review','coi_gap_feedback','core_claim','reporter_profile_confirm','reporter_profile_reject','reporter_profile_revoke','opportunity_submission') NOT NULL;
