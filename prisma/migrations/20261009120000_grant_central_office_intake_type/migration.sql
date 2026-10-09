-- #2180 — record which InfoEd central office administers a grant record and
-- its intake type, so /edit can tell an admin who to contact to correct it.
--
-- `central_office` is InfoEd `prop_u.P_SIN_18` ('OSRA' / 'JCTO'); `intake_type`
-- is `prop_u.p_sin_5` (free text, 13 values). Written by `etl:infoed` only.
--
-- Nullable with NO default on purpose: InfoEd leaves the office null/blank on
-- ~17.5% of awarded accounts and the intake type blank on ~24%, and a
-- synthetic default would make a missing value indistinguishable from a real
-- one (the `program_type` DEFAULT 'Grant' failure mode). NULL = unknown.
--
-- Additive DDL only; the running app image never selects these columns, so
-- this can land ahead of the image that reads them. Rows stay NULL until the
-- next `etl:infoed` run.

-- AlterTable
ALTER TABLE `grant` ADD COLUMN `central_office` VARCHAR(64) NULL,
    ADD COLUMN `intake_type` VARCHAR(255) NULL;
