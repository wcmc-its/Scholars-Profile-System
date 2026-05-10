-- Issue #165 — canonical per-scholar weillcornell.org clinical profile URL,
-- sourced from the ED `labeledURI;pops` attribute on the ou=people entry.
-- Nullable additive column; backfilled on the next ED ETL run.

ALTER TABLE `scholar`
  ADD COLUMN `clinical_profile_url` VARCHAR(512) NULL;
