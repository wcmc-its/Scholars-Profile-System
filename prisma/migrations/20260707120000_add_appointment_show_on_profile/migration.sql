-- #1323 — historical academic appointments (source "ED-HISTORICAL", imported from
-- the WOOFA faculty SOR's `faculty:expired` rows) are hidden from the public
-- profile by default. A curator or comms_steward can reveal one for public
-- display by flipping this flag; the CV export ignores the flag and always
-- includes historical appointments.
--
-- Additive: one new NOT NULL column with a default, so existing rows (all active
-- ED / ED-NYP / Jenzabar appointments) backfill to false and stay visible as
-- before. See docs/1323-... and issue #1323.

-- AlterTable
ALTER TABLE `appointment` ADD COLUMN `show_on_profile` BOOLEAN NOT NULL DEFAULT false;
