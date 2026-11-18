-- Vice Chair modifiers are open-ended ("Deputy", "Interim Executive", …), read
-- from the published title rather than picked from five fixed tiers. Widen the
-- column to hold them. Existing values are unchanged.
ALTER TABLE `unit_leadership_role` MODIFY `tier` VARCHAR(64) NOT NULL;
