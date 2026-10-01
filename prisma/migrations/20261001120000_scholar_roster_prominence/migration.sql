-- #2596 — materialize the /edit roster prominence score + leadership tier.
--
-- Written nightly by `etl:roster-prominence` from `computeProminence`
-- (lib/api/prominence.ts, the one formula), so roster pages can ORDER BY and
-- paginate in the DB instead of scoring the whole roster in-app. Named
-- `roster_*` so nobody repoints people search (lib/search.ts, a different,
-- banded score) at it.
--
-- Nullable: NULL = not scored yet, distinguishable from a real zero. Additive
-- DDL only; the running app image never selects these, so this can land ahead
-- of the image that reads them. No index yet: the consumer switch adds the one
-- its ORDER BY needs.

-- AlterTable
ALTER TABLE `scholar` ADD COLUMN `roster_prominence` DOUBLE NULL,
    ADD COLUMN `roster_leadership_tier` DOUBLE NULL; -- fractional: TITLE_RANK.viceChair = 8.5
