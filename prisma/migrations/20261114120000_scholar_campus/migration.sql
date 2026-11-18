-- Ithaca ORCID plan, step 1: Cornell Ithaca people become scholar rows with
-- campus 'ithaca' and status 'external' (etl/ithaca-roster). Every existing row
-- is a WCM row. Additive; ED and its prune scope to campus 'wcm'.
ALTER TABLE `scholar` ADD COLUMN `campus` VARCHAR(16) NOT NULL DEFAULT 'wcm';
