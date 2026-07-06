-- Opportunity URL intake (docs/opportunity-url-intake-spec.md) -- extend the
-- B03 audit ENUMs with the `opportunity_submission` action + entity type.
--
-- Run as a schema-privileged user (NOT the app role) against each env's
-- scholars_audit BEFORE flipping OPPORTUNITY_URL_INTAKE on -- while the flag
-- is off nothing writes the new values, so ordering is: migrate, then flip.
-- Appending values to the END of a MySQL ENUM is an in-place metadata change
-- (no table rebuild, no row rewrites); appending (never reordering) also keeps
-- existing rows' stored ordinals stable. Canonical DDL: audit-log.sql.

ALTER TABLE scholars_audit.manual_edit_audit
  MODIFY COLUMN `target_entity_type` ENUM('scholar','publication','grant','education','appointment','department','division','center','mentee','coi_gap_candidate','method_family','core','reporter_profile_candidate','opportunity_submission') NOT NULL;

ALTER TABLE scholars_audit.manual_edit_audit
  MODIFY COLUMN `action` ENUM('field_override','field_override_clear','suppression_create','suppression_revoke','request_change','slug_request','slug_request_approved','slug_request_rejected','slug_request_withdrawn','unit_create','roster_change','grant_change','impersonation_start','impersonation_end','publication_reject','coi_gap_dismiss','coi_gap_restore','proxy_grant','proxy_revoke','family_tier_set','family_review','coi_gap_feedback','core_claim','reporter_profile_confirm','reporter_profile_reject','reporter_profile_revoke','opportunity_submission') NOT NULL;
