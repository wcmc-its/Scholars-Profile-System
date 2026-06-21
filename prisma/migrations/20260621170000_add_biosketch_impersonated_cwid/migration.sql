-- AlterTable
-- #917 v6 follow-up -- record the accountable human + impersonation overlay on each draft.
-- `created_by_cwid` now carries the signed-in actor (matching `manual_edit_audit.actor_cwid`);
-- this adds the "View as" overlay target for a delegated/impersonated generation. Additive +
-- nullable -- existing rows read NULL here (no backfill). NOTE: pre-migration `created_by_cwid`
-- stored the EFFECTIVE cwid, so any row generated through a "View as" overlay holds the
-- IMPERSONATED TARGET (not the real actor) and is unrecoverable -- the panel renders it with no
-- "(as ...)" for those rows. Staging-only feature (prod flag off), so prod has no such rows.
ALTER TABLE `biosketch_generation`
  ADD COLUMN `impersonated_cwid` VARCHAR(32) NULL;
