-- Issue #171 — scholar ORCID, sourced from the WCM Identity DynamoDB table
-- (etl/identity). Stored as the bare 19-char identifier
-- "0000-0002-1825-0097". Nullable additive column; backfilled on the next
-- Identity ETL run.

ALTER TABLE `scholar`
  ADD COLUMN `orcid` VARCHAR(19) NULL;
