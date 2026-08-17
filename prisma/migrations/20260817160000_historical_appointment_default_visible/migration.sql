-- #1323 follow-up: hiding prior faculty appointments by default made
-- long-tenured faculty look newly arrived. Flips the column default so a
-- newly-imported ED-HISTORICAL appointment is visible unless a curator hides
-- it (mirrors the always-shown active-appointment behavior). Existing rows
-- are untouched by this DDL — see scripts/backfill-reveal-historical-appointments.ts
-- for the one-time data backfill.
-- AlterTable
ALTER TABLE `appointment` ALTER COLUMN `show_on_profile` SET DEFAULT true;
