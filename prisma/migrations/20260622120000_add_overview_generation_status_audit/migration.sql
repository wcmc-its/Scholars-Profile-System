-- AlterTable
-- Persist EVERY overview generation attempt (not just successes) + audit parity with
-- `biosketch_generation`. `status`/`error` record failed runs (`text` is NULL on failure);
-- `impersonated_cwid` records the "View as" overlay target so a delegated draft is
-- attributed to the human who actually ran it. All additive: existing rows default to
-- status='succeeded' with NULL impersonated_cwid (no backfill); `text` is widened to NULL
-- for failed rows while existing rows keep their non-null draft.
-- NOTE: pre-migration `created_by_cwid` stored the EFFECTIVE cwid, so any row generated
-- through a "View as" overlay holds the impersonated target, not the real actor; those rows
-- render without an "(as ...)" attribution. The generate flag is on in both envs, so such
-- rows may exist -- unrecoverable, accepted.
ALTER TABLE `overview_generation`
  ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'succeeded',
  ADD COLUMN `error` TEXT NULL,
  ADD COLUMN `impersonated_cwid` VARCHAR(32) NULL,
  MODIFY `text` TEXT NULL;
